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
    for (const p of ["/", "/brand", "/creator", "/verify", "/static/app.js"]) expect((await fetch(`${base}${p}`)).status).toBe(200);
    expect((await getJson("/.well-known/agent-card.json")).url).toBe(`${base}/a2a`);
    const s = await getJson("/api/state");
    expect(s.rail).toBe("permit2");
    expect(s.gateway).toBe("emulator");
    expect(s.operator).toBe(true);
  });

  it("licence → paid render → Verify says Licensed → only the licensee can download", async () => {
    const { licenceId } = await (await post("/api/brand/license", { renderCap: 2 })).json();
    const paid = await (await post("/api/brand/pay", { licenceId })).json();
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
    const paid = await (await post("/api/brand/pay", { licenceId })).json();
    expect((await post("/api/creator/revoke", { licenceId })).status).toBe(200);
    const again = await post("/api/brand/pay", { licenceId });
    expect(again.status).toBe(409);
    expect((await again.json()).error).toMatch(/revoked/);
    expect((await getJson(`/api/verify?hash=${paid.assetHash}`)).verdict).toBe("Revoked");
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
