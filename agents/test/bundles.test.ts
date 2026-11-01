import { createServer, type Server } from "node:http";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { AdGenerator } from "../src/ai/generate.js";
import { DailyCap, OperatorAuth, RateLimit, type Guard } from "../src/app/guard.js";
import type { SignedIn } from "../src/app/firebase.js";
import { startRuntime, type Runtime } from "../src/app/runtime.js";
import { handle } from "../src/app/server.js";

describe("licence bundles: one request, one licence per media type on chain (local devnet, fake AI)", () => {
  let rt: Runtime;
  let server: Server;
  let base = "";
  const root = `${mkdtempSync(join(tmpdir(), "likeness-bundles-"))}/`;
  const users: Record<string, SignedIn> = {
    creator: { uid: "u-c", email: "c@example.com", name: "Creator", picture: null },
    brand: { uid: "u-b", email: "b@example.com", name: "Brand Co", picture: null },
    other: { uid: "u-o", email: "o@example.com", name: "Other Brand", picture: null },
  };
  const sent: string[] = [];
  const ai: AdGenerator = {
    check: async (brief) => (/forbidden/.test(brief) ? { allowed: false, reasons: ["banned use: test"] } : { allowed: true, reasons: [] }),
    image: async ({ brief, prompt }) => (sent.push(prompt ?? brief), { bytes: new TextEncoder().encode(`JPEG ${brief} ${Math.random()}`), mime: "image/jpeg", model: "fake" }),
    video: async ({ brief, prompt, motion }) => (sent.push(`${prompt} | ${motion}`), { bytes: new TextEncoder().encode(`MP4 ${brief} ${Math.random()}`), mime: "video/mp4", model: "fake" }),
  };
  const guard: Guard = { auth: new OperatorAuth("x".repeat(12)), reads: new RateLimit(1e6), actions: new RateLimit(1e6), logins: new RateLimit(100), cap: new DailyCap(`${root}cap.json`, 20) };
  const call = async (who: string | null, path: string, body?: unknown) => {
    const headers: Record<string, string> = { "content-type": "application/json", ...(who ? { authorization: `Bearer ${who}` } : {}) };
    const r = await fetch(`${base}${path}`, body === undefined ? { headers } : { method: "POST", headers, body: JSON.stringify(body) });
    return { status: r.status, body: await r.json().catch(() => null) };
  };
  const pay = async (licenceId: string, extra: Record<string, string> = {}, who = "brand") => {
    const r = await call(who, "/api/brand/pay", { licenceId, ...extra });
    if (r.status !== 200) return r.body;
    for (;;) {
      const j = await call(who, `/api/brand/job?id=${r.body.jobId}`);
      if (["delivered", "refused", "failed"].includes(j.body.job.state)) return j.body.job;
      if (j.body.approvals.length) await call(who, "/api/brand/approve", { id: j.body.approvals[0].id, decision: "approve" });
      await new Promise((res) => setTimeout(res, 100));
    }
  };
  const jpeg = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x04, 0x00, 0x00]), Buffer.from([0xff, 0xda, 0x00, 0x02, 0xff, 0xd9])]);
  let creator = "";

  beforeAll(async () => {
    mkdirSync(`${root}renders`, { recursive: true });
    server = createServer((req, res) => void handle(rt, req, res, guard));
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
    const a = server.address();
    base = `http://127.0.0.1:${typeof a === "object" && a ? a.port : 0}`;
    process.env.LIKENESS_HSP = "agentic";
    rt = await startRuntime({ mode: "local", root, publicUrl: base, operator: true, ai, verifyIdToken: async (t) => (users[t] ? users[t]! : Promise.reject(new Error("bad token"))) });
    delete process.env.LIKENESS_HSP;
    await call("creator", "/api/me/role", { role: "creator" });
    await rt.onboarding.connectYoutube("u-c", { id: "UC-c", title: "C", thumbnail: null });
    await call("creator", "/api/me/creator/photo", { data: jpeg.toString("base64"), consent: true });
    creator = (await call("creator", "/api/me/creator/register", { price: "0.04", categories: [256], maxRenders: 5, adult: true })).body.creator.address;
    await call("brand", "/api/me/role", { role: "brand" });
    await call("other", "/api/me/role", { role: "brand" });
  }, 120_000);
  afterAll(() => {
    server?.close();
    rt?.stop();
    rmSync(root, { recursive: true, force: true });
  });

  it("checks the request before issuing anything", async () => {
    expect((await call("brand", "/api/brand/bundle", { creator, brief: "shoes", images: 6, videos: 0 })).status).toBe(400);
    expect((await call("brand", "/api/brand/bundle", { creator, brief: "shoes", images: 0, videos: 0 })).status).toBe(400);
    expect((await call("brand", "/api/brand/bundle", { creator, brief: "something forbidden", images: 1, videos: 1 })).status).toBe(422);
    expect((await call("brand", "/api/bundles?who=brand")).body).toEqual([]);
  });

  it("issues an image licence (1x) and a video licence (3x), then makes an image and a video under it", async () => {
    const r = await call("brand", "/api/brand/bundle", { creator, brief: "running shoes on a sunny street", images: 2, videos: 1 });
    expect(r.status).toBe(200);
    const b = r.body.bundle;
    expect(b).toMatchObject({ partial: false, status: "Active", brief: "running shoes on a sunny street", wanted: { images: 2, videos: 1 }, image: { used: 0, cap: 2, price: "0.04" }, video: { used: 0, cap: 1, price: "0.12" } });

    const img = await pay(b.image.licenceId);
    expect(img).toMatchObject({ state: "delivered", kind: "image", mime: "image/jpeg" });
    const vid = await pay(b.video.licenceId);
    expect(vid).toMatchObject({ state: "delivered", kind: "video", mime: "video/mp4" });

    const [after] = (await call("brand", "/api/bundles?who=brand")).body;
    expect(after).toMatchObject({ id: b.id, image: { used: 1, cap: 2 }, video: { used: 1, cap: 1, status: "Exhausted" } });
    const v = (await call(null, `/api/verify?hash=${vid.assetHash}`)).body;
    expect(v).toMatchObject({ verdict: "Licensed", bundle: { id: b.id, brief: "running shoes on a sunny street", brand: "Brand Co", imageLicence: b.image.licenceId, videoLicence: b.video.licenceId, kind: "video" } });
    expect((await call("creator", "/api/bundles?who=creator")).body.map((x: { id: string }) => x.id)).toContain(b.id);
  }, 180_000);

  it("a bundle whose second licence fails stays partial, and a retry issues it", async () => {
    const license = rt.brand.license.bind(rt.brand);
    let n = 0;
    rt.brand.license = async (...a: Parameters<typeof license>) => (++n === 2 ? Promise.reject(new Error("RPC timeout")) : license(...a));
    const r = await call("brand", "/api/brand/bundle", { creator, brief: "sunglasses at the beach", images: 1, videos: 1 });
    expect(r.body.error).toMatch(/video licence wasn't issued: RPC timeout/);
    expect(r.body.bundle).toMatchObject({ partial: true, image: { cap: 1 }, video: null });
    rt.brand.license = license;
    const again = await call("brand", "/api/brand/bundle/retry", { bundleId: r.body.bundle.id });
    expect(again.body.error).toBeUndefined();
    expect(again.body.bundle).toMatchObject({ partial: false, video: { cap: 1, price: "0.12" } });
  }, 120_000);

  it("the creator revokes the whole bundle (two transactions); both media types are refused before signing", async () => {
    const r = await call("brand", "/api/brand/bundle", { creator, brief: "a coffee brand, cosy cafe", images: 2, videos: 1 });
    const b = r.body.bundle;
    const img = await pay(b.image.licenceId);
    expect((await call("brand", "/api/creator/revoke", { bundleId: b.id })).status).toBe(403);
    const rv = await call("creator", "/api/creator/revoke", { bundleId: b.id });
    expect(rv.status).toBe(200);
    expect(rv.body.txs.map((t: { kind: string }) => t.kind)).toEqual(["image", "video"]);
    const [view] = (await call("brand", "/api/bundles?who=brand")).body.filter((x: { id: string }) => x.id === b.id);
    expect(view).toMatchObject({ status: "Revoked", image: { status: "Revoked" }, video: { status: "Revoked" } });
    for (const id of [b.image.licenceId, b.video.licenceId]) expect((await pay(id)).error).toMatch(/Refused before anything was signed/);
    expect((await call(null, `/api/verify?hash=${img.assetHash}`)).body.verdict).toBe("Revoked");
  }, 180_000);

  it("pre-fills the exact prompt, refuses an edited banned prompt before anything is signed, and records the prompt it used", async () => {
    const { bundle } = (await call("brand", "/api/brand/bundle", { creator, brief: "a smartwatch on a morning run", images: 2, videos: 1 })).body;
    const p = (await call("brand", `/api/brand/prompt?licenceId=${bundle.image.licenceId}`)).body;
    expect(p.kind).toBe("image");
    expect(p.prompt).toMatch(/exactly this person[\s\S]*Brief: a smartwatch on a morning run/);
    expect((await call("other", `/api/brand/prompt?licenceId=${bundle.image.licenceId}`)).status).toBe(403);
    // The video part runs as the second brand: the first has used today's one video.
    const { bundle: other } = (await call("other", "/api/brand/bundle", { creator, brief: "a smartwatch on a morning run", images: 0, videos: 1 })).body;
    const v = (await call("other", `/api/brand/prompt?licenceId=${other.video.licenceId}`)).body;
    expect(v.motion).toMatch(/^a smartwatch on a morning run\n/);

    const orders = () => rt.log.events.filter((e) => e.kind === "hsp.request").length;
    const before = orders();
    const refused = await call("brand", "/api/brand/pay", { licenceId: bundle.image.licenceId, prompt: `${p.prompt}\nMake it look like something forbidden` });
    expect(refused.status).toBe(422);
    expect(refused.body.error).toMatch(/prompt was refused, nothing was signed/);
    expect(orders()).toBe(before);

    const edited = p.prompt.replace("a smartwatch on a morning run", "a smartwatch on a morning run by the sea, golden hour");
    const job = await pay(bundle.image.licenceId, { prompt: edited });
    expect(job.state).toBe("delivered");
    expect(sent.at(-1)).toBe(edited);
    const sha = `0x${createHash("sha256").update(edited).digest("hex")}`;
    expect(job.promptSha256).toBe(sha);
    expect((await call(null, `/api/verify?hash=${job.assetHash}`)).body.render).toMatchObject({ kind: "image", prompt: edited, promptSha256: sha, model: "fake" });

    const vjob = await pay(other.video.licenceId, { motion: "a slow orbit around the watch" }, "other");
    expect(sent.at(-1)).toBe(`${v.prompt} | a slow orbit around the watch`);
    expect((await call(null, `/api/verify?hash=${vjob.assetHash}`)).body.render.prompt).toMatch(/^Opening frame \(image model\):[\s\S]*Motion \(Veo\):\na slow orbit around the watch$/);
  }, 180_000);

  it("galleries: a brand sees only its renders, the creator every render of their likeness, nobody else", async () => {
    const mine = (await call("brand", "/api/renders?who=brand")).body.renders;
    expect(mine.length).toBeGreaterThanOrEqual(4);
    expect(mine.every((r: { uid: string }) => r.uid === "u-b")).toBe(true);
    expect(mine[0].createdAt).toBeGreaterThanOrEqual(mine.at(-1).createdAt);
    expect(mine.some((r: { licenceStatus: string }) => r.licenceStatus === "Revoked")).toBe(true);
    const others = (await call("other", "/api/renders?who=brand")).body.renders;
    expect(others).toHaveLength(1);
    expect(others[0].uid).toBe("u-o");
    const theirs = (await call("creator", "/api/renders?who=creator")).body.renders;
    expect(theirs.map((r: { assetHash: string }) => r.assetHash).sort()).toEqual([...mine, ...others].map((r: { assetHash: string }) => r.assetHash).sort());
    expect(new Set(theirs.map((r: { brand: string }) => r.brand))).toEqual(new Set(["Brand Co", "Other Brand"]));
    expect((await call(null, "/api/renders?who=brand")).status).toBe(401);
    expect((await call(null, "/api/renders?who=creator")).status).toBe(401);
    expect((await call("brand", "/api/renders?who=creator")).status).toBe(403);
    expect((await call("creator", "/api/renders?who=brand")).status).toBe(403);

    const file = (who: string | null, h: string, v = "file") => fetch(`${base}/api/renders/${h}/${v}`, { headers: who ? { authorization: `Bearer ${who}` } : {} });
    const h = mine[0].assetHash;
    expect((await file("brand", h)).status).toBe(200);
    expect((await file("creator", h)).status).toBe(200);
    expect((await file("other", h)).status).toBe(403);
    expect((await file(null, h)).status).toBe(401);
  }, 60_000);

  it("Verify still answers for a file anchored under a deployment that was replaced", async () => {
    const [r] = (await call("brand", "/api/renders?who=brand")).body.renders;
    const current = rt.chain;
    const original = current.receiptOf.bind(current);
    // The current ReceiptAnchor doesn't know the file; the replaced one (here, the same contracts) does.
    rt.previous = [Object.assign(Object.create(Object.getPrototypeOf(current)), current, { receiptOf: original })];
    current.receiptOf = (async () => [false, { licenceId: 0n, renderIndex: 0, timestamp: 0n }]) as unknown as typeof current.receiptOf;
    try {
      const v = (await call(null, `/api/verify?hash=${r.assetHash}`)).body;
      expect(v).toMatchObject({ deployment: "previous", licenceId: r.licenceId, bundle: null });
      expect(["Licensed", "Revoked", "Expired"]).toContain(v.verdict);
    } finally {
      current.receiptOf = original;
      rt.previous = [];
    }
    expect((await call(null, `/api/verify?hash=${r.assetHash}`)).body.deployment).toBeUndefined();
  });
});

