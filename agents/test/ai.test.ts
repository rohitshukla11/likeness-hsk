import { createServer, type Server } from "node:http";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import sharp from "sharp";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ruleCheck } from "../src/ai/filter.js";
import { ffmpegPath, labelImage, labelVideo, motionPrompt, stillPrompt, type AdGenerator } from "../src/ai/generate.js";
import { DailyCap, OperatorAuth, RateLimit, type Guard } from "../src/app/guard.js";
import type { SignedIn } from "../src/app/firebase.js";
import { startRuntime, type Runtime } from "../src/app/runtime.js";
import { handle, SITE_CAPS } from "../src/app/server.js";

describe("AI ad helpers", () => {
  it("refuses briefs with banned uses by rule, before any model is asked", () => {
    expect(ruleCheck("Rohit holding our new sneakers in a sunny park")).toEqual([]);
    expect(ruleCheck("Rohit asking people to vote for the senator")[0]).toMatch(/^Political/);
    expect(ruleCheck("a deepfake confession")[0]).toMatch(/^Deception/);
  });

  it("puts the brief inside prompts that keep the creator faithful and text-free", () => {
    expect(stillPrompt("sneakers in a park", "image")).toMatch(/exactly this person[\s\S]*Brief: sneakers in a park/);
    expect(stillPrompt("x", "video")).toMatch(/16:9/);
    expect(motionPrompt("sneakers")).toMatch(/^sneakers\n[\s\S]*No text/);
  });

  it("burns the AI label into an image (JPEG) and a video (H.264 MP4)", async () => {
    const png = await sharp({ create: { width: 640, height: 640, channels: 3, background: "#3a6" } }).png().toBuffer();
    const img = await labelImage(png);
    expect((await sharp(img).metadata()).format).toBe("jpeg");
    expect(Buffer.from(img).equals(await sharp(png).jpeg({ quality: 90 }).toBuffer())).toBe(false);

    const dir = mkdtempSync(join(tmpdir(), "likeness-ai-test-"));
    try {
      execFileSync(ffmpegPath(), ["-y", "-f", "lavfi", "-i", "testsrc=size=640x360:rate=24:duration=1", "-pix_fmt", "yuv420p", join(dir, "in.mp4")], { stdio: "ignore" });
      const mp4 = await labelVideo(new Uint8Array(execFileSync("cat", [join(dir, "in.mp4")])));
      expect(Buffer.from(mp4).subarray(4, 8).toString()).toBe("ftyp");
      expect(mp4.length).toBeGreaterThan(1000);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, 120_000);
});

describe("AI image and video ads on the app server (local devnet, fake Vertex AI)", () => {
  let rt: Runtime;
  let server: Server;
  let base = "";
  const root = `${mkdtempSync(join(tmpdir(), "likeness-ai-app-"))}/`;
  const users: Record<string, SignedIn> = {
    creator: { uid: "u-c", email: "c@example.com", name: "Creator", picture: null },
    brand: { uid: "u-b", email: "b@example.com", name: "Brand", picture: null },
  };
  const made: string[] = [];
  const fakeAi: AdGenerator = {
    check: async (brief) => (/forbidden/.test(brief) ? { allowed: false, reasons: ["banned use: test"] } : { allowed: true, reasons: [] }),
    image: async ({ brief, photo }) => (made.push(`image:${brief}:${photo.mime}`), { bytes: new TextEncoder().encode(`JPEG of ${brief}`), mime: "image/jpeg", model: "fake-image" }),
    video: async ({ brief, onProgress }) => {
      onProgress?.("generating the video");
      made.push(`video:${brief}`);
      return { bytes: new TextEncoder().encode(`MP4 of ${brief}`), mime: "video/mp4", model: "fake-image + fake-veo" };
    },
  };
  const guard: Guard = { auth: new OperatorAuth("x".repeat(12)), reads: new RateLimit(1e6), actions: new RateLimit(1e6), logins: new RateLimit(100), cap: new DailyCap(`${root}cap.json`, 20) };
  const call = async (who: string | null, path: string, body?: unknown) => {
    const headers: Record<string, string> = { "content-type": "application/json", ...(who ? { authorization: `Bearer ${who}` } : {}) };
    const r = await fetch(`${base}${path}`, body === undefined ? { headers } : { method: "POST", headers, body: JSON.stringify(body) });
    return { status: r.status, body: await r.json().catch(() => null) };
  };
  const pay = async (licenceId: string, brief?: string) => {
    const r = await call("brand", "/api/brand/pay", { licenceId, ...(brief ? { brief } : {}) });
    if (r.status !== 200) return r.body;
    for (;;) {
      const j = await call("brand", `/api/brand/job?id=${r.body.jobId}`);
      if (["delivered", "refused", "failed"].includes(j.body.job.state)) return j.body.job;
      if (j.body.approvals.length) await call("brand", "/api/brand/approve", { id: j.body.approvals[0].id, decision: "approve" });
      await new Promise((res) => setTimeout(res, 100));
    }
  };
  const jpeg = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x04, 0x00, 0x00]), Buffer.from([0xff, 0xda, 0x00, 0x02, 0xff, 0xd9])]);

  beforeAll(async () => {
    mkdirSync(`${root}renders`, { recursive: true });
    server = createServer((req, res) => void handle(rt, req, res, guard));
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
    const a = server.address();
    base = `http://127.0.0.1:${typeof a === "object" && a ? a.port : 0}`;
    process.env.LIKENESS_HSP = "agentic";
    rt = await startRuntime({ mode: "local", root, publicUrl: base, operator: true, ai: fakeAi, verifyIdToken: async (t) => (users[t] ? users[t]! : Promise.reject(new Error("bad token"))) });
    delete process.env.LIKENESS_HSP;
    await call("creator", "/api/me/role", { role: "creator" });
    await rt.onboarding.connectYoutube("u-c", { id: "UC-c", title: "C", thumbnail: null });
    await call("creator", "/api/me/creator/photo", { data: jpeg.toString("base64"), consent: true });
    await call("creator", "/api/me/creator/register", { price: "0.04", categories: [256], maxRenders: 5, adult: true });
    await call("brand", "/api/me/role", { role: "brand" });
  }, 120_000);
  afterAll(() => {
    server?.close();
    rt?.stop();
    rmSync(root, { recursive: true, force: true });
  });

  it("refuses a banned brief before any licence or payment", async () => {
    const creator = (await call("creator", "/api/me")).body.creator.address;
    const r = await call("brand", "/api/brand/license", { creator, kind: "image", brief: "something forbidden" });
    expect(r.status).toBe(422);
    expect(r.body.error).toMatch(/brief was refused/);
    expect(made).toEqual([]);
  });

  it("an image licence: paid, then the AI image of the creator, anchored and Verify says Licensed", async () => {
    const creator = (await call("creator", "/api/me")).body.creator.address;
    const { licenceId, kind } = (await call("brand", "/api/brand/license", { creator, kind: "image", brief: "sneakers in a sunny park" })).body;
    expect(kind).toBe("image");
    expect((await rt.chain.licence(BigInt(licenceId))).pricePerRender).toBe(40_000n);
    const job = await pay(licenceId);
    expect(job).toMatchObject({ state: "delivered", kind: "image", mime: "image/jpeg", model: "fake-image" });
    expect(made).toEqual(["image:sneakers in a sunny park:image/jpeg"]);
    expect(rt.store.read(job.assetHash)!.bytes.toString()).toBe("JPEG of sneakers in a sunny park");
    expect((await call(null, `/api/verify?hash=${job.assetHash}`)).body.verdict).toBe("Licensed");
  }, 120_000);

  it("a video licence costs 3 renders' worth on chain, pays once, delivers an MP4, then the video cap holds", async () => {
    const creator = (await call("creator", "/api/me")).body.creator.address;
    const { licenceId } = (await call("brand", "/api/brand/license", { creator, kind: "video", brief: "sneakers, slow push-in" })).body;
    expect((await rt.chain.licence(BigInt(licenceId))).pricePerRender).toBe(120_000n);
    const job = await pay(licenceId);
    expect(job).toMatchObject({ state: "delivered", kind: "video", mime: "video/mp4" });
    expect((await rt.chain.payment(BigInt(licenceId), 0)).amount).toBe(120_000n);
    expect((await call(null, `/api/verify?hash=${job.assetHash}`)).body.verdict).toBe("Licensed");
    expect((await call("brand", "/api/me")).body.brand.video).toEqual({ used: 1, cap: 1 });
    expect((await call("brand", "/api/brand/pay", { licenceId })).body.error).toMatch(/today's 1 video ads/);
    expect((await call(null, "/api/state")).body.ads).toMatchObject({ ai: true, videoMultiplier: 3, siteCaps: SITE_CAPS, usedToday: { image: 1, video: 1 } });
  }, 120_000);
});
