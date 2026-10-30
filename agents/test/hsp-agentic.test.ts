/**
 * HSP Agentic Payment (MCP) through the agents, offline: the emulator speaks MCP with the same eight
 * tools, the agents use the real MCP client, and the contracts run on a local chain.
 */
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { recoverTypedDataAddress } from "viem";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Refused } from "../src/brand-agent/agent.js";
import { ADVERTISING, PRICE, startDevnet, type Devnet } from "../src/dev/devnet.js";
import { chooseOption, paymentOptions } from "../src/hsp/agentic/chainConfig.js";
import { HSP_TOOLS, HspAgentic, HspSchemaMismatch, MERCHANT_NAME } from "../src/hsp/agentic/client.js";
import { emulatorTools } from "../src/hsp/agentic/emulator.js";
import { diffReport, diffSchemas } from "../src/hsp/agentic/schemaDiff.js";
import { terminalApprover } from "../src/hsp/agentic/terminal.js";
import { PassThrough } from "node:stream";
import { z } from "zod";
import { type Approval, type Approver, typedData, watchPayment } from "../src/hsp/agentic/payer.js";

const LICENCE = { category: ADVERTISING, regions: 1, durationSeconds: 7n * 86400n, renderCap: 3, purpose: "spring campaign" };

describe("HSP Agentic Payment through the agents (EIP-3009, offline MCP emulator)", () => {
  let n: Devnet;
  let approver: Approver = async () => true;
  const seen: Approval[] = [];
  beforeAll(async () => {
    n = await startDevnet({ hsp: "agentic", approve: (a) => (seen.push(a), approver(a)) });
  });
  afterAll(() => n?.stop());

  it("lists all eight tools from the server", () => {
    expect([...n.agentic!.hsp.tools.keys()].sort()).toEqual([...HSP_TOOLS].sort());
  });

  it("creates the order as Likeness, asks twice with the same recipient, payer and raw amount, and records with the Gateway's nonce", async () => {
    seen.length = 0;
    approver = async () => true;
    const id = await n.brand.license(n.conn, LICENCE);
    const before = await n.balanceOf(n.payout);
    const paid = await n.brand.payForRender(n.conn, id);
    expect(seen.map((a) => a.stage)).toEqual(["sign", "submit"]);
    for (const a of seen) expect(a).toMatchObject({ payTo: n.payout, payer: n.accounts.brand.address, tokenTotalRaw: PRICE.toString() });
    expect(paid.tokenTotalRaw).toBe(PRICE.toString());

    const p = await n.brand.waitRecorded(id, 0, { timeoutMs: 30_000 });
    expect(p).toMatchObject({ payer: n.accounts.brand.address, amount: PRICE, nonceBound: false });
    expect((await n.balanceOf(n.payout)) - before).toBe(PRICE);

    const order = n.agentic!.emulator.orders.get(paid.flowId!)!;
    expect(order.merchantName).toBe(MERCHANT_NAME);
    expect(order.status).toBe("payment-finalized");
    expect(p.hspTxHash).toBe(order.txHash);
    const q = await n.agentic!.hsp.queryPayment({ flow_id: paid.flowId!, payment_request_id: paid.paymentRequestId });
    expect(q.attribution_verified).toBe(true);
    expect((await n.agentic!.hsp.queryPayment({ flow_id: paid.flowId! }, "Another team")).attribution_verified).toBe(false);

    const kinds = n.log.events.map((e) => `${e.actor}:${e.kind}`);
    for (const k of ["creator-agent:hsp.request", "brand-agent:approval", "brand-agent:payment-mandate", "hsp-gateway:hsp.status", "chain:tx"]) expect(kinds).toContain(k);
  });

  it("cancelling before signing: nothing signed, no money moved", async () => {
    seen.length = 0;
    approver = async () => false;
    const id = await n.brand.license(n.conn, LICENCE);
    const before = await n.balanceOf(n.accounts.brand.address);
    await expect(n.brand.payForRender(n.conn, id)).rejects.toThrow(/cancelled before signing: nothing was signed/);
    expect(seen.map((a) => a.stage)).toEqual(["sign"]);
    expect(await n.balanceOf(n.accounts.brand.address)).toBe(before);
  });

  it("cancelling before submission: signed but never sent, no money moved", async () => {
    seen.length = 0;
    approver = async (a) => a.stage === "sign";
    const id = await n.brand.license(n.conn, LICENCE);
    const before = await n.balanceOf(n.accounts.brand.address);
    const err = await n.brand.payForRender(n.conn, id).catch((e) => e);
    expect(err).toBeInstanceOf(Refused);
    expect(err.message).toMatch(/cancelled before submission: the authorization was signed but never sent/);
    expect(seen.map((a) => a.stage)).toEqual(["sign", "submit"]);
    await new Promise((r) => setTimeout(r, 300));
    expect(await n.balanceOf(n.accounts.brand.address)).toBe(before);
  });

  it("checks every call against the live schema: an argument the schema doesn't have stops the call", () => {
    expect(() => n.agentic!.hsp.conform("get_order", { flow_id: "x", extra: 1 })).toThrow(HspSchemaMismatch);
    expect(() => n.agentic!.hsp.conform("create_order", { merchant_name: MERCHANT_NAME, pay_to: n.payout })).toThrow(/requires cart_mandate/);
  });
});

describe("HSP Agentic Payment: an expired quote is prepared and approved again", () => {
  let n: Devnet;
  const seen: Approval[] = [];
  beforeAll(async () => {
    let first = true;
    n = await startDevnet({
      hsp: "agentic",
      quoteSeconds: 1,
      approve: async (a) => {
        seen.push(a);
        if (first) {
          first = false;
          await new Promise((r) => setTimeout(r, 1300)); // the quote expires while the user decides
        }
        return true;
      },
    });
  });
  afterAll(() => n?.stop());

  it("never signs or submits the expired quote", async () => {
    const id = await n.brand.license(n.conn, LICENCE);
    await n.brand.payForRender(n.conn, id);
    expect(seen.map((a) => a.stage)).toEqual(["sign", "sign", "submit"]);
    expect(seen[0]!.quoteExpiresAt).not.toBe(seen[1]!.quoteExpiresAt);
    const p = await n.brand.waitRecorded(id, 0, { timeoutMs: 30_000 });
    expect(p.amount).toBe(PRICE);
  });
});

describe("HSP Agentic Payment on the Permit2 rail (USDT)", () => {
  let n: Devnet;
  beforeAll(async () => {
    n = await startDevnet({ hsp: "agentic", rail: "permit2" });
  });
  afterAll(() => n?.stop());

  it("signs PermitTransferFrom with the Gateway's nonce and is recorded on chain", async () => {
    const id = await n.brand.license(n.conn, LICENCE);
    const paid = await n.brand.payForRender(n.conn, id);
    const p = await n.brand.waitRecorded(id, 0, { timeoutMs: 30_000 });
    expect(p).toMatchObject({ amount: PRICE, nonceBound: false, nonce: paid.nonce });
  });
});

describe("HSP Agentic Payment client and helpers", () => {
  it("refuses a server without all eight tools", async () => {
    const s = new McpServer({ name: "partial", version: "0" });
    for (const t of HSP_TOOLS.filter((x) => x !== "finalize_payment")) s.registerTool(t, { inputSchema: {} }, async () => ({ content: [{ type: "text" as const, text: "{}" }] }));
    const [c, srv] = InMemoryTransport.createLinkedPair();
    await s.connect(srv);
    await expect(HspAgentic.connect(c, "emulator")).rejects.toThrow(/missing tool\(s\): finalize_payment/);
  });

  it("won't contact HashKey's server before the allowlisting is confirmed", async () => {
    const saved = process.env.HSP_ALLOWLISTED;
    delete process.env.HSP_ALLOWLISTED;
    try {
      await expect(HspAgentic.connectQa("http://127.0.0.1:9/")).rejects.toThrow(/isn't confirmed as allowlisted/);
    } finally {
      if (saved !== undefined) process.env.HSP_ALLOWLISTED = saved;
    }
  });

  it("signs the returned eip712 unchanged in content (integers given as strings)", async () => {
    const a = privateKeyToAccount(generatePrivateKey());
    const e = {
      domain: { name: "Bridged USDC", version: "2", chainId: "133", verifyingContract: "0x0000000000000000000000000000000000000001" },
      types: {
        EIP712Domain: [{ name: "name", type: "string" }],
        TransferWithAuthorization: [
          { name: "from", type: "address" },
          { name: "to", type: "address" },
          { name: "value", type: "uint256" },
          { name: "validAfter", type: "uint256" },
          { name: "validBefore", type: "uint256" },
          { name: "nonce", type: "bytes32" },
        ],
      },
      primaryType: "TransferWithAuthorization",
      message: { from: a.address, to: "0x0000000000000000000000000000000000000002", value: "50000", validAfter: "0", validBefore: "9999999999", nonce: `0x${"ab".repeat(32)}` },
    };
    const td = typedData(e);
    expect(td.message.value).toBe(50000n);
    expect(td.domain.chainId).toBe(133);
    const sig = await a.signTypedData(td as never);
    expect(await recoverTypedDataAddress({ ...(td as Parameters<typeof recoverTypedDataAddress>[0]), signature: sig })).toBe(a.address);
  });

  it("chooses the network and token only from get_chain_config, and asks when there are several", () => {
    const one = { networks: [{ network: "hashkey-testnet", chain_id: 133, tokens: [{ symbol: "USDC", address: "0x00000000000000000000000000000000000000c1", decimals: 6, payment_protocol: "eip3009" }] }] };
    expect(chooseOption(one)).toMatchObject({ network: "hashkey-testnet", chainId: 133, token: { symbol: "USDC", protocol: "eip3009", decimals: 6 } });
    const two = { networks: [{ ...one.networks[0]!, tokens: [...one.networks[0]!.tokens, { symbol: "USDT", address: "0x00000000000000000000000000000000000000d2", decimals: 6, payment_protocol: "permit2" }] }] };
    expect(paymentOptions(two)).toHaveLength(2);
    expect(() => chooseOption(two)).toThrow(/several options; choose one/);
    expect(chooseOption(two, { token: "0x00000000000000000000000000000000000000d2" }).token.protocol).toBe("permit2");
    expect(() => chooseOption({ something: 1 })).toThrow(/no network with tokens found \(top-level keys: something\)/);
  });

  it("reports payment-safe as not finalized, in the guide's words", async () => {
    const fake = { queryPayment: async () => ({ payment: { status: "payment-safe", tx_signature: "0x1" }, attribution_verified: true }) } as unknown as HspAgentic;
    const updates: string[] = [];
    const end = await watchPayment(fake, { flow_id: "f", payment_request_id: "p" }, (w) => updates.push(w.status), { intervalMs: 1 });
    expect(end.note).toBe("The transaction is on-chain and has received half of the required block confirmations. It is not yet finalized.");
    expect(updates).toEqual(["payment-safe"]);
  });
});

describe("live schemas that differ from the emulator's", () => {
  /** A server with all eight tools; `shapes` overrides some tools' input schemas, `answer` what they return. */
  const serve = async (shapes: Record<string, Record<string, z.ZodType>>, answer: (tool: string, args: unknown) => unknown = () => ({})) => {
    const s = new McpServer({ name: "live-like", version: "0" });
    for (const t of HSP_TOOLS) s.registerTool(t, { inputSchema: shapes[t] ?? {} }, async (a: unknown) => ({ content: [{ type: "text" as const, text: JSON.stringify(answer(t, a)) }] }));
    const [c, srv] = InMemoryTransport.createLinkedPair();
    await s.connect(srv);
    return HspAgentic.connect(c, "emulator");
  };

  it("adapts to clearly equivalent names (camelCase, payer_address) and maps camelCase answers back", async () => {
    let got: unknown;
    const hsp = await serve(
      { prepare_payment: { flowId: z.string(), payerAddress: z.string(), protocol: z.string() }, create_order: { merchantName: z.string(), payTo: z.string(), cartMandate: z.object({}).passthrough() } },
      (t, a) => ((got = a), t === "create_order" ? { flowId: "F1", paymentRequestId: "P1" } : {}),
    );
    const order = await hsp.createOrder({ merchant_name: MERCHANT_NAME, pay_to: "0x0000000000000000000000000000000000000001", cart_mandate: { contents: {} } });
    expect(order).toMatchObject({ flow_id: "F1", payment_request_id: "P1" });
    expect(got).toMatchObject({ merchantName: MERCHANT_NAME, payTo: "0x0000000000000000000000000000000000000001" });
    expect(hsp.conform("prepare_payment", { flow_id: "F1", payer: "0xabc", protocol: "eip3009" })).toEqual({ flowId: "F1", payerAddress: "0xabc", protocol: "eip3009" });
    expect([...hsp.adaptations]).toEqual(expect.arrayContaining(["create_order.merchant_name → merchantName", "prepare_payment.payer → payerAddress"]));
  });

  it("stops instead of guessing: an ambiguous name, or a required field the flow doesn't know", async () => {
    const hsp = await serve({ prepare_payment: { flow_id: z.string(), payer: z.string(), payer_address: z.string(), protocol: z.string() }, get_order: { flow_id: z.string(), merchant_id: z.string() } });
    expect(() => hsp.conform("prepare_payment", { flow_id: "F", payer: "0xabc", protocol: "eip3009" })).toThrow(/could be any of payer, payer_address in its live schema; stopping to ask/);
    expect(() => hsp.conform("get_order", { flow_id: "F" })).toThrow(/requires merchant_id, which this flow doesn't know; stopping to ask/);
  });

  it("the diff report says which tools adapt and which need a decision", async () => {
    const em = await emulatorTools();
    const live = em.map((t) =>
      t.name === "prepare_payment"
        ? { ...t, inputSchema: { type: "object", properties: { flowId: { type: "string" }, payer_address: { type: "string" }, protocol: { type: "string" } }, required: ["flowId", "payer_address", "protocol"] } }
        : t.name === "get_order"
          ? { ...t, inputSchema: { type: "object", properties: { flow_id: { type: "string" }, merchant_id: { type: "string" } }, required: ["flow_id", "merchant_id"] } }
          : t,
    );
    const d = diffSchemas(live, em);
    expect(d.find((x) => x.tool === "prepare_payment")!.adapted).toEqual([{ ours: "flow_id", live: "flowId" }, { ours: "payer", live: "payer_address" }]);
    expect(d.find((x) => x.tool === "get_order")!.stop).toEqual([`the live schema requires "merchant_id", which the flow doesn't know`]);
    expect(diffReport(d)).toMatch(/1 tool\(s\) need a decision/);
    expect(diffReport(diffSchemas(em, em))).toMatch(/No stops/);
  });
});

describe("the terminal approvals (pnpm run testnet)", () => {
  const approval: Approval = {
    stage: "sign",
    flowId: "F",
    paymentRequestId: "P",
    payTo: "0x0000000000000000000000000000000000000002",
    payer: "0x0000000000000000000000000000000000000003",
    tokenTotalRaw: "50000",
    token: { address: "0x0000000000000000000000000000000000000004", decimals: 6, symbol: "USDT" },
    quoteExpiresAt: new Date(Date.now() + 60_000).toISOString(),
    gasFeeAdvanced: true,
  };
  const ask = async (typed: string | null, interactive = true, a: Approval = approval) => {
    const input = new PassThrough();
    const output = new PassThrough();
    let shown = "";
    output.on("data", (c) => (shown += String(c)));
    const p = terminalApprover({ input, output, interactive })(a);
    if (typed !== null) setTimeout(() => input.write(`${typed}\n`), 20);
    return { yes: await p, shown };
  };
  it("shows the recipient, payer and token_total_raw, and approves only on \"yes\"", async () => {
    const r = await ask("yes");
    expect(r.yes).toBe(true);
    expect(r.shown).toMatch(/recipient \(pay_to\): 0x0{39}2/);
    expect(r.shown).toMatch(/payer: +0x0{39}3/);
    expect(r.shown).toMatch(/token_total_raw: +50000 raw units \(≈ 0\.050000 USDT/);
    expect((await ask("y")).yes).toBe(false);
  });
  it("never approves without a person: no terminal, or the quote expires first", async () => {
    expect((await ask(null, false)).yes).toBe(false);
    const r = await ask(null, true, { ...approval, quoteExpiresAt: new Date(Date.now() + 100).toISOString() });
    expect(r.yes).toBe(false);
    expect(r.shown).toMatch(/quote expired before an answer/);
  });
});

