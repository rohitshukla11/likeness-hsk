import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { describe, expect, it } from "vitest";
import { LiveQa, LIVE_QA_LABEL, SEPOLIA_USDC, type LiveQaRun } from "../src/app/liveQa.js";
import { HspAgentic } from "../src/hsp/agentic/client.js";
import { rehearsalQa } from "../src/hsp/agentic/qaRehearsal.js";

const PAYOUT = "0x00000000000000000000000000000000000000a1" as const;
const signer = privateKeyToAccount(generatePrivateKey());

const live = (o: { balance?: bigint; feeRaw?: bigint; statuses?: string[] } = {}) =>
  new LiveQa({
    connect: () => rehearsalQa({ feeRaw: o.feeRaw, statuses: o.statuses }),
    source: "rehearsal",
    signer,
    payTo: async () => PAYOUT,
    balanceOf: async () => o.balance ?? 1_000_000n,
    pollMs: 1,
    explorerTx: (tx) => `https://sepolia.etherscan.io/tx/${tx}`,
  });

/** Waits for the next question (or the end), then answers it. */
async function next(q: LiveQa, run: LiveQaRun, yes = true) {
  for (let i = 0; i < 400 && !run.ask && ["working", "watching"].includes(run.status); i++) await new Promise((r) => setTimeout(r, 5));
  const ask = run.ask;
  if (!ask) return undefined;
  expect(q.answer(ask.id, yes)).toBe(true);
  return ask;
}
async function settle(run: LiveQaRun) {
  for (let i = 0; i < 400 && !run.endedAt; i++) await new Promise((r) => setTimeout(r, 5));
}

describe("the admin's live HashKey QA payment (offline rehearsal server)", () => {
  it("confirms merchant_name, pay_to and the payer one at a time, approves twice, and follows the payment to finalized", async () => {
    const q = live();
    const run = await q.start();
    expect(run.label).toContain(LIVE_QA_LABEL);
    expect(run.label).toMatch(/^REHEARSAL/);
    expect(await next(q, run)).toMatchObject({ kind: "merchant_name", value: "Likeness" });
    expect(await next(q, run)).toMatchObject({ kind: "pay_to", value: PAYOUT });
    expect(await next(q, run)).toMatchObject({ kind: "payer", value: signer.address });
    const sign = await next(q, run);
    expect(sign).toMatchObject({ kind: "sign", approval: { payTo: PAYOUT, payer: signer.address, tokenTotalRaw: "50000", token: { address: SEPOLIA_USDC, symbol: "USDC" } } });
    expect(await next(q, run)).toMatchObject({ kind: "submit", approval: { tokenTotalRaw: "50000" } });
    await settle(run);
    expect(run).toMatchObject({ status: "done", paymentStatus: "payment-finalized", attributionVerified: true, chainId: 11155111, tokenTotalRaw: "50000" });
    expect(run.txUrl).toMatch(/^https:\/\/sepolia\.etherscan\.io\/tx\/0x[0-9a-f]{64}$/);
    expect(run.steps.map((s) => s.what).join("\n")).toMatch(/get_chain_config: sepolia \(chain 11155111\), USDC 0x1c7D.*eip3009, EIP-712 "USDC" version 2[\s\S]*create_order: flow_id[\s\S]*signed TransferWithAuthorization[\s\S]*query_payment: payment-finalized/);
  });

  it("no order is created unless merchant_name is confirmed", async () => {
    const q = live();
    const run = await q.start();
    await next(q, run, false);
    await settle(run);
    expect(run).toMatchObject({ status: "cancelled", error: "merchant_name not confirmed: no order created" });
    expect(run.flowId).toBeUndefined();
  });

  it("declining approval 1: nothing signed", async () => {
    const q = live();
    const run = await q.start();
    for (let i = 0; i < 3; i++) await next(q, run);
    expect(await next(q, run, false)).toMatchObject({ kind: "sign" });
    await settle(run);
    expect(run.status).toBe("cancelled");
    expect(run.error).toMatch(/nothing was signed/);
    expect(run.steps.some((s) => s.what.includes("signed TransferWithAuthorization"))).toBe(false);
  });

  it("a network fee in the total is shown for approval; a fee beyond the headroom stops before signing", async () => {
    const withFee = live({ feeRaw: 30_000n });
    const run = await withFee.start();
    for (let i = 0; i < 3; i++) await next(withFee, run);
    expect(await next(withFee, run, false)).toMatchObject({ approval: { tokenTotalRaw: "80000" } });
    await settle(run);

    const tooMuch = live({ feeRaw: 300_000n });
    const r2 = await tooMuch.start();
    for (let i = 0; i < 3; i++) await next(tooMuch, r2);
    await settle(r2);
    expect(r2.status).toBe("cancelled");
    expect(r2.error).toMatch(/above this render's budget .*nothing signed/);
  });

  it("stops before signing when the brand wallet holds too little USDC", async () => {
    const q = live({ balance: 10_000n });
    const run = await q.start();
    for (let i = 0; i < 3; i++) await next(q, run);
    await settle(run);
    expect(run.status).toBe("cancelled");
    expect(run.error).toMatch(/holds 10000 raw units of USDC .* below token_total_raw 50000: nothing signed/);
  });

  it("reports payment-safe as not finalized, and runs one payment at a time", async () => {
    const q = live({ statuses: ["payment-processing", "payment-safe"] });
    const run = await q.start();
    await expect(q.start()).rejects.toThrow(/already in progress/);
    for (let i = 0; i < 5; i++) await next(q, run);
    await settle(run);
    expect(run).toMatchObject({ status: "done", paymentStatus: "payment-safe" });
    expect(run.note).toMatch(/not yet finalized/);
  });

  it("connects to HashKey's QA server for this run only with HSP_QA_LIVE_RUN=1, without switching the main flow", async () => {
    const saved = { a: process.env.HSP_ALLOWLISTED, l: process.env.HSP_QA_LIVE_RUN };
    delete process.env.HSP_ALLOWLISTED;
    delete process.env.HSP_QA_LIVE_RUN;
    try {
      await expect(HspAgentic.connectQa("http://127.0.0.1:9/", { liveRun: true })).rejects.toThrow(/isn't confirmed as allowlisted/);
      process.env.HSP_QA_LIVE_RUN = "1";
      await expect(HspAgentic.connectQa("http://127.0.0.1:9/")).rejects.toThrow(/isn't confirmed as allowlisted/);
      // With the flag, the live run gets past the gate (and fails here only because nothing listens on port 9).
      await expect(HspAgentic.connectQa("http://127.0.0.1:9/", { liveRun: true })).rejects.not.toThrow(/allowlisted/);
    } finally {
      if (saved.a !== undefined) process.env.HSP_ALLOWLISTED = saved.a;
      if (saved.l !== undefined) process.env.HSP_QA_LIVE_RUN = saved.l;
      else delete process.env.HSP_QA_LIVE_RUN;
    }
  });
});
