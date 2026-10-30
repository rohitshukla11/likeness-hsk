import { createServer, type Server } from "node:http";
import { privateKeyToAccount, generatePrivateKey } from "viem/accounts";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { claimMessage } from "../src/app/claim.js";
import { startRuntime, type Runtime } from "../src/app/runtime.js";
import { handle } from "../src/app/server.js";
import { mkdtempSync, rmSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

describe("the app server (local devnet, emulated HSP Gateway)", () => {
  let rt: Runtime;
  let server: Server;
  let base = "";
  const root = `${mkdtempSync(join(tmpdir(), "likeness-app-"))}/`;
  const post = (path: string, body: unknown) => fetch(`${base}${path}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  const getJson = async (path: string) => (await fetch(`${base}${path}`)).json();
  /** Starts a payment and follows its job to the end. */
  const pay = async (licenceId: string) => {
    const { jobId } = await (await post("/api/brand/pay", { licenceId })).json();
    for (;;) {
      const r = await getJson(`/api/brand/job?id=${jobId}`);
      if (["delivered", "paid-not-recorded", "refused", "failed"].includes(r.job.state)) return r.job;
      await new Promise((res) => setTimeout(res, 100));
    }
  };

  beforeAll(async () => {
    mkdirSync(`${root}renders`, { recursive: true });
    server = createServer((req, res) => void handle(rt, req, res));
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
    const a = server.address();
    base = `http://127.0.0.1:${typeof a === "object" && a ? a.port : 0}`;
    rt = await startRuntime({ mode: "local", root, publicUrl: base, operator: true });
  });
  afterAll(() => {
    server?.close();
    rt?.stop();
    rmSync(root, { recursive: true, force: true });
  });

  it("serves the pages, the agent card and the state", async () => {
    for (const p of ["/", "/brand", "/creator", "/verify", "/agent", "/static/app.js"]) expect((await fetch(`${base}${p}`)).status).toBe(200);
    expect((await getJson("/.well-known/agent-card.json")).url).toBe(`${base}/a2a`);
    const s = await getJson("/api/state");
    expect(s.rail).toBe("permit2");
    expect(s.gateway).toBe("emulator");
    expect(s.operator).toBe(true);
  });

  it("licence → paid render → Verify says Licensed → only the licensee can download", async () => {
    const { licenceId } = await (await post("/api/brand/license", { renderCap: 2 })).json();
    const paid = await pay(licenceId);
    expect(paid.state).toBe("delivered");
    expect(paid.nonceBound).toBe(true);
    expect(paid.assetHash).toMatch(/^0x[0-9a-f]{64}$/);

    const v = await getJson(`/api/verify?hash=${paid.assetHash}`);
    expect(v.verdict).toBe("Licensed");
    expect(v.licensee).toBe(rt.brandAddress);
    expect((await getJson(`/api/verify?hash=0x${"0".repeat(64)}`)).verdict).toBe("Unknown");

    const dl = `/api/renders/${paid.assetHash}`;
    // No signature, someone else's signature, a stale claim: refused.
    expect((await post(dl, {})).status).toBe(403);
    const stranger = privateKeyToAccount(generatePrivateKey());
    const { issuedAt, message } = await getJson(dl);
    expect((await post(dl, { issuedAt, signature: await stranger.signMessage({ message }) })).status).toBe(403);
    const old = new Date(Date.now() - 6 * 60_000).toISOString();
    const oldMsg = claimMessage({ assetHash: paid.assetHash, licenceId: BigInt(licenceId), chainId: rt.chain.d.chainId, issuedAt: old });
    expect((await post(dl, { issuedAt: old, signature: await rt.brandAccount().signMessage({ message: oldMsg }) })).status).toBe(403);
    // The licensee's signature: the file.
    const ok = await post(dl, { issuedAt, signature: await rt.brandAccount().signMessage({ message }) });
    expect(ok.status).toBe(200);
    expect(await ok.text()).toContain("TEST RENDER");
  });

  it("the creator revokes; the next payment is refused before money moves; Verify then says Revoked", async () => {
    const { licenceId } = await (await post("/api/brand/license", { renderCap: 2 })).json();
    const paid = await pay(licenceId);
    expect((await post("/api/creator/revoke", { licenceId })).status).toBe(200);
    const again = await pay(licenceId);
    expect(again.state).toBe("refused");
    expect(again.error).toMatch(/revoked/);
    const v = await getJson(`/api/verify?hash=${paid.assetHash}`);
    expect(v.verdict).toBe("Revoked");
    expect(v.recordTx).toMatch(/^0x[0-9a-f]{64}$/);
    expect(v.anchorTx).toMatch(/^0x[0-9a-f]{64}$/);
    const payments = await getJson("/api/payments?who=creator");
    const mine = payments.find((p: { licenceId: string }) => p.licenceId === licenceId);
    expect(mine.amount).toBe("50000");
    expect(mine.hspTx).toBe(paid.hspTx);
    expect(mine.anchorTx).toBe(paid.anchorTx);
    const list = await getJson("/api/licences?who=creator");
    expect(list.find((l: { id: string }) => l.id === licenceId).status).toBe("Revoked");
  });

  it("the message log shows the whole story, public data only", async () => {
    const log = await getJson("/api/log?since=0");
    const kinds = new Set(log.map((e: { kind: string }) => e.kind));
    for (const k of ["a2a.request", "cart-mandate", "payment-mandate", "hsp.webhook", "tx", "refused"]) expect(kinds).toContain(k);
    expect(JSON.stringify(log)).not.toMatch(/BEGIN (EC )?PRIVATE KEY/);
  });
});

describe("the app server with HSP Agentic Payment (local devnet, MCP emulator)", () => {
  let rt: Runtime;
  let server: Server;
  let base = "";
  const root = `${mkdtempSync(join(tmpdir(), "likeness-app-"))}/`;
  const post = (path: string, body: unknown) => fetch(`${base}${path}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  const getJson = async (path: string) => (await fetch(`${base}${path}`)).json();

  beforeAll(async () => {
    mkdirSync(`${root}renders`, { recursive: true });
    server = createServer((req, res) => void handle(rt, req, res));
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
    const a = server.address();
    base = `http://127.0.0.1:${typeof a === "object" && a ? a.port : 0}`;
    process.env.LIKENESS_HSP = "agentic";
    try {
      rt = await startRuntime({ mode: "local", root, publicUrl: base, operator: true });
    } finally {
      delete process.env.LIKENESS_HSP;
    }
  });
  afterAll(() => {
    server?.close();
    rt?.stop();
    rmSync(root, { recursive: true, force: true });
  });

  it("asks in the console before signing and before submitting, then shows HSP's statuses, the tx and the attribution", async () => {
    const s = await getJson("/api/state");
    expect(s.gateway).toBe("hsp-agentic-emulator");
    expect(s.agentic).toMatchObject({ source: "emulator", recordable: true, merchantName: "Likeness" });

    const { licenceId } = await (await post("/api/brand/license", { renderCap: 2 })).json();
    const { jobId } = await (await post("/api/brand/pay", { licenceId })).json();
    const stages: string[] = [];
    let r;
    for (let i = 0; i < 600; i++) {
      r = await getJson(`/api/brand/job?id=${jobId}`);
      const a = r.approvals[0];
      if (a) {
        stages.push(a.stage);
        expect(a).toMatchObject({ payTo: s.payout, payer: s.brand, tokenTotalRaw: "50000" });
        expect((await post("/api/brand/approve", { id: a.id, decision: "approve" })).status).toBe(200);
        expect((await post("/api/brand/approve", { id: a.id, decision: "approve" })).status).toBe(409); // answered once
      }
      if (["delivered", "paid-not-recorded", "refused", "failed"].includes(r.job.state)) break;
      await new Promise((res) => setTimeout(res, 100));
    }
    expect(stages).toEqual(["sign", "submit"]);
    expect(r.job.state).toBe("delivered");
    // Polling can skip states; the last one seen is an end state (safe or finalized).
    expect(["payment-safe", "payment-finalized"]).toContain(r.statuses.at(-1).status);
    expect(r.tx).toMatch(/^0x[0-9a-f]{64}$/);
    expect(r.attribution).toBe(true);
    expect((await getJson(`/api/verify?hash=${r.job.assetHash}`)).verdict).toBe("Licensed");
  });

  it("cancelling in the console: refused, nothing signed", async () => {
    const { licenceId } = await (await post("/api/brand/license", { renderCap: 2 })).json();
    const { jobId } = await (await post("/api/brand/pay", { licenceId })).json();
    let r;
    for (let i = 0; i < 600; i++) {
      r = await getJson(`/api/brand/job?id=${jobId}`);
      if (r.approvals[0]) await post("/api/brand/approve", { id: r.approvals[0].id, decision: "cancel" });
      if (["refused", "failed", "delivered"].includes(r.job.state)) break;
      await new Promise((res) => setTimeout(res, 100));
    }
    expect(r.job).toMatchObject({ state: "refused" });
    expect(r.job.error).toMatch(/nothing was signed/);
  });
});

