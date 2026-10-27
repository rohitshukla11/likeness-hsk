import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { CART_MANDATE_KEY } from "../src/a2a/types.js";
import { sendMessage, userMessage } from "../src/a2a/client.js";
import { Refused } from "../src/brand-agent/agent.js";
import { webhookSignatureHeader } from "../src/hsp/webhook.js";
import { ADVERTISING, PRICE, SOCIAL, startDevnet, type Devnet } from "./helpers/devnet.js";

const LICENCE = { category: ADVERTISING, regions: 1, durationSeconds: 7n * 86400n, renderCap: 2, purpose: "spring campaign" };

describe("end to end: A2A → AP2 Cart Mandate → Payment Mandate → HSP Gateway → HSK settlement (USDC.e, bound nonce)", () => {
  let n: Devnet;
  beforeAll(async () => {
    n = await startDevnet();
  });
  afterAll(() => n?.stop());

  it("serves an A2A agent card with the AP2 merchant role and the deployment", async () => {
    const card = await (await fetch(`${n.creatorAgentUrl}/.well-known/agent-card.json`)).json();
    expect(card.url).toBe(`${n.creatorAgentUrl}/a2a`);
    expect(card.skills.map((s: { id: string }) => s.id)).toEqual(["likeness.terms", "likeness.render-payment"]);
    expect(card.capabilities.extensions[0].params.roles).toEqual(["merchant"]);
  });

  it("licenses, pays per render through HSP, records on chain with the bound nonce, anchors the receipt", async () => {
    const id = await n.brand.license(n.conn, LICENCE);
    const before = await n.balanceOf(n.payout);

    const paid = await n.brand.payForRender(n.conn, id);
    expect(paid.nonceBound).toBe(true);
    const p = await n.brand.waitRecorded(id, 0);
    expect(p.nonceBound).toBe(true);
    expect(p.payer).toBe(n.accounts.brand.address);
    expect(p.amount).toBe(PRICE);
    expect(p.hspTxHash).toBe(paid.txHash);
    expect((await n.balanceOf(n.payout)) - before).toBe(PRICE);
    expect(await n.balanceOf(n.chain.d.settlement)).toBe(0n);

    const out = await n.render.renderAndAnchor(id, 0, "spring campaign hero shot");
    const [found, receipt] = await n.chain.receiptOf(out.assetHash);
    expect(found).toBe(true);
    expect(receipt.licenceId).toBe(id);

    // The message log tells the story in order.
    const kinds = n.log.events.map((e) => `${e.actor}:${e.kind}`);
    for (const step of [
      "brand-agent:a2a.request",
      "creator-agent:cart-mandate",
      "hsp-gateway:hsp.response",
      "brand-agent:payment-mandate",
      "hsp-gateway:hsp.webhook",
      "chain:tx",
    ]) expect(kinds).toContain(step);
    expect(JSON.stringify(n.log.events)).not.toMatch(/appSecret|app_secret"\s*:\s*"[0-9a-f]{16}/);
  });

  it("refuses before any money moves once the licence is used up", async () => {
    const id = await n.brand.license(n.conn, { ...LICENCE, renderCap: 1 });
    await n.brand.payForRender(n.conn, id);
    await n.brand.waitRecorded(id, 0);
    const orders = n.emulator.orders.size;
    await expect(n.brand.payForRender(n.conn, id)).rejects.toBeInstanceOf(Refused);
    expect(n.emulator.orders.size).toBe(orders); // no cart was even created
  });

  it("revocation: the brand refuses to pay, and the creator agent refuses to quote", async () => {
    const id = await n.brand.license(n.conn, LICENCE);
    await n.revoke(id);
    const before = await n.balanceOf(n.accounts.brand.address);
    await expect(n.brand.payForRender(n.conn, id)).rejects.toThrow(/revoked/);
    const task = await sendMessage(n.conn.card, userMessage([{ kind: "data", data: { skill: "likeness.render-payment", licenceId: id.toString() } }]));
    expect(task.status.state).toBe("rejected");
    expect(task.artifacts).toEqual([]);
    expect(await n.balanceOf(n.accounts.brand.address)).toBe(before);
  });

  it("the payment agent rejects a cart that was changed after the merchant signed it", async () => {
    const id = await n.brand.license(n.conn, LICENCE);
    const tampering: typeof fetch = async (input, init) => {
      const res = await fetch(input, init);
      if (!String(input).endsWith("/a2a")) return res;
      const body = await res.json();
      const cart = body.result?.artifacts?.[0]?.parts?.[0]?.data?.[CART_MANDATE_KEY];
      if (cart) cart.contents.payment_request.method_data[0].data.pay_to = "0x000000000000000000000000000000000000dEaD";
      return new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });
    };
    const { BrandAgent } = await import("../src/brand-agent/agent.js");
    const { HspClient } = await import("../src/hsp/client.js");
    const evil = new BrandAgent({
      account: n.accounts.brand,
      chain: n.chain,
      hsp: new HspClient({ baseUrl: n.emulator.baseUrl }),
      policy: { maxPricePerRender: 100_000n, allowedCategories: ADVERTISING, dailyBudget: 1_000_000n, maxRendersPerLicence: 5 },
      log: n.log,
      fetch: tampering,
    });
    await expect(evil.payForRender(n.conn, id)).rejects.toThrow("cart_hash does not match");
  });

  it("the daily budget stops the payment agent before it signs", async () => {
    const tight = await startDevnet({ policy: { dailyBudget: PRICE } });
    try {
      const id = await tight.brand.license(tight.conn, LICENCE);
      await tight.brand.payForRender(tight.conn, id);
      await tight.brand.waitRecorded(id, 0);
      await expect(tight.brand.payForRender(tight.conn, id)).rejects.toThrow(/daily budget/);
    } finally {
      tight.stop();
    }
  });

  it("a webhook with a bad signature is rejected and records nothing", async () => {
    const body = JSON.stringify({ event_type: "payment", status: "payment-included", cart_mandate_id: "LIK-31337-1-0-00000000" });
    const res = await fetch(`${n.creatorAgentUrl}/hsp/webhook`, {
      method: "POST",
      headers: { "content-type": "application/json", "X-Signature": webhookSignatureHeader("not-the-app-secret", body) },
      body,
    });
    expect(res.status).toBe(401);
  });

  it("terms over A2A agree with the chain; a use outside the brand's policy is refused", async () => {
    const t = await n.brand.terms(n.conn, ADVERTISING);
    expect(t.pricePerRender).toBe(PRICE);
    await expect(n.brand.terms(n.conn, SOCIAL)).rejects.toBeInstanceOf(Refused);
  });
});

describe("end to end when the HSP Gateway assigns the nonce", () => {
  let n: Devnet;
  beforeAll(async () => {
    n = await startDevnet({ nonceMode: "gateway" });
  });
  afterAll(() => n?.stop());

  it("records the nonce that executed, unbound, and it counts once", async () => {
    const id = await n.brand.license(n.conn, LICENCE);
    const paid = await n.brand.payForRender(n.conn, id);
    expect(paid.nonceBound).toBe(false);
    const p = await n.brand.waitRecorded(id, 0);
    expect(p.nonceBound).toBe(false);
    expect(p.nonce).toBe(paid.nonce);
    expect(await n.chain.nonceRecorded(n.accounts.brand.address, paid.nonce)).toBe(true);
    const out = await n.render.renderAndAnchor(id, 0, "hero");
    expect((await n.chain.receiptOf(out.assetHash))[0]).toBe(true);
  });
});

describe("end to end on the USDT rail (Permit2)", () => {
  let n: Devnet;
  beforeAll(async () => {
    n = await startDevnet({ rail: "permit2" });
  });
  afterAll(() => n?.stop());

  it("pays through Permit2 and records with the bound nonce", async () => {
    const id = await n.brand.license(n.conn, LICENCE);
    const before = await n.balanceOf(n.payout);
    await n.brand.payForRender(n.conn, id);
    const p = await n.brand.waitRecorded(id, 0);
    expect(p.nonceBound).toBe(true);
    expect((await n.balanceOf(n.payout)) - before).toBe(PRICE);
  });
});
