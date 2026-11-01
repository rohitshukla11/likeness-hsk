import { createServer, type Server } from "node:http";
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createLocalJWKSet, exportJWK, generateKeyPair, SignJWT } from "jose";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { DailyCap, OperatorAuth, RateLimit, type Guard } from "../src/app/guard.js";
import { firebaseVerifier, type SignedIn } from "../src/app/firebase.js";
import { photoType, stripJpegMetadata, youtubeChannel } from "../src/app/onboarding.js";
import { startRuntime, type Runtime } from "../src/app/runtime.js";
import { BRAND_CAPS, handle } from "../src/app/server.js";

describe("app records across a redeploy", () => {
  it("archives licences, bundles and renders when the LicenseRegistry changes; keeps accounts and creators", async () => {
    const { Accounts } = await import("../src/app/accounts.js");
    const dir = mkdtempSync(join(tmpdir(), "likeness-archive-"));
    try {
      const a = new Accounts(`${dir}/accounts.sqlite`);
      expect(a.ensureDeployment("0x00000000000000000000000000000000000000a1")).toBe(0);
      a.upsert({ uid: "u1", email: "u1@example.com", name: "U1", picture: null });
      a.createCreator("u1", "0x00000000000000000000000000000000000000c1", "U1", null);
      a.recordLicence("1", "u1", "0x00000000000000000000000000000000000000c1");
      a.setLicenceMeta("1", "image", "shoes");
      a.createBundle({ id: "B1", uid: "u1", creator: "0x00000000000000000000000000000000000000c1", brief: "shoes", images: 1, videos: 0, duration: 86400 });
      const hash = `0x${"ab".repeat(32)}`;
      a.saveRender({ assetHash: hash, licenceId: "1", renderIndex: 0, kind: "image", mime: "image/jpeg", size: 1, prompt: "p", promptSha256: "0x1", model: "m", note: null, uid: "u1", creator: "0x00000000000000000000000000000000000000c1", bundleId: "B1", hspTx: null, anchorTx: null, createdAt: 1 });
      expect(a.ensureDeployment("0x00000000000000000000000000000000000000A1")).toBe(0); // same registry, any case
      expect(a.ensureDeployment("0x00000000000000000000000000000000000000b2")).toBe(4);
      expect(a.licenceOwner("1")).toBeUndefined();
      expect(a.bundles()).toEqual([]);
      expect(a.renders()).toEqual([]);
      expect(a.render(hash)?.prompt).toBe("p"); // still readable for Verify
      expect(a.account("u1")?.email).toBe("u1@example.com");
      expect(a.creator("u1")?.address).toBe("0x00000000000000000000000000000000000000c1");
      expect(a.ensureDeployment("0x00000000000000000000000000000000000000b2")).toBe(0);
      a.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("Firebase ID tokens", () => {
  it("accepts a Google sign-in for this project only", async () => {
    const { publicKey, privateKey } = await generateKeyPair("RS256");
    const jwk = { ...(await exportJWK(publicKey)), kid: "k1", alg: "RS256" };
    const verify = firebaseVerifier("likeness-hsk", createLocalJWKSet({ keys: [jwk] }));
    const token = (claims: Record<string, unknown>, aud = "likeness-hsk") =>
      new SignJWT({ email: "a@example.com", email_verified: true, name: "A", firebase: { sign_in_provider: "google.com" }, ...claims })
        .setProtectedHeader({ alg: "RS256", kid: "k1" })
        .setIssuer(`https://securetoken.google.com/${aud}`)
        .setAudience(aud)
        .setSubject("uid-a")
        .setIssuedAt()
        .setExpirationTime("1h")
        .sign(privateKey);
    expect(await verify(await token({}))).toEqual({ uid: "uid-a", email: "a@example.com", name: "A", picture: null });
    await expect(verify(await token({}, "bionic-carving-140911"))).rejects.toThrow();
    await expect(verify(await token({ firebase: { sign_in_provider: "password" } }))).rejects.toThrow(/Google/);
    await expect(verify(await token({ email_verified: false }))).rejects.toThrow(/verified/);
  });
});

describe("creator onboarding helpers", () => {
  it("keeps only the signed-in account's own YouTube channel", async () => {
    const fake = (email: string, scope = "openid https://www.googleapis.com/auth/youtube.readonly") =>
      (async (url: string) =>
        new Response(
          JSON.stringify(
            String(url).includes("tokeninfo") ? { email, scope } : { items: [{ id: "UC123", snippet: { title: "Rohit", thumbnails: { high: { url: "https://yt/t.jpg" } } } }] },
          ),
        )) as unknown as typeof fetch;
    expect(await youtubeChannel("t", "me@example.com", fake("me@example.com"))).toEqual({ id: "UC123", title: "Rohit", thumbnail: "https://yt/t.jpg" });
    await expect(youtubeChannel("t", "me@example.com", fake("someone@example.com"))).rejects.toThrow(/signed in with/);
    await expect(youtubeChannel("t", "me@example.com", fake("me@example.com", "openid"))).rejects.toThrow(/read access/);
  });

  it("accepts JPEG, PNG and WebP only, and strips a JPEG's EXIF", () => {
    const exif = Buffer.concat([Buffer.from([0xff, 0xe1, 0x00, 0x0c]), Buffer.from("Exif\0\0GPS!!")]);
    const jpeg = Buffer.concat([Buffer.from([0xff, 0xd8]), exif, Buffer.from([0xff, 0xda, 0x00, 0x04, 0x01, 0x02, 0xff, 0xd9])]);
    expect(photoType(jpeg)?.mime).toBe("image/jpeg");
    expect(stripJpegMetadata(jpeg).includes(Buffer.from("GPS"))).toBe(false);
    expect(photoType(Buffer.from("<svg></svg>"))).toBeUndefined();
  });
});

describe("Google accounts on the app server (local devnet, public guard)", () => {
  let rt: Runtime;
  let server: Server;
  let base = "";
  const root = `${mkdtempSync(join(tmpdir(), "likeness-accounts-"))}/`;
  const users: Record<string, SignedIn> = {
    creator: { uid: "u-creator", email: "creator@example.com", name: "Rohit (test)", picture: null },
    brand: { uid: "u-brand", email: "brand@example.com", name: "Brand A", picture: null },
    other: { uid: "u-other", email: "other@example.com", name: "Brand B", picture: null },
  };
  const guard: Guard = { auth: new OperatorAuth("x".repeat(12)), reads: new RateLimit(1e6), actions: new RateLimit(1e6), logins: new RateLimit(100), cap: new DailyCap(`${root}cap.json`, 20) };
  const call = async (who: string | null, path: string, body?: unknown) => {
    const headers: Record<string, string> = { "content-type": "application/json", ...(who ? { authorization: `Bearer ${who}` } : {}) };
    const r = await fetch(`${base}${path}`, body === undefined ? { headers } : { method: "POST", headers, body: JSON.stringify(body) });
    return { status: r.status, body: await r.json().catch(() => null) };
  };
  const pay = async (who: string, licenceId: string) => {
    const r = await call(who, "/api/brand/pay", { licenceId });
    if (r.status !== 200) return r.body;
    for (;;) {
      const j = await call(who, `/api/brand/job?id=${r.body.jobId}`);
      if (["delivered", "refused", "failed"].includes(j.body.job.state)) return j.body.job;
      if (j.body.approvals.length) await call(who, "/api/brand/approve", { id: j.body.approvals[0].id, decision: "approve" });
      await new Promise((res) => setTimeout(res, 100));
    }
  };
  // A minimal JPEG with an EXIF segment (only its magic bytes matter here).
  const jpeg = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe1, 0x00, 0x08]), Buffer.from("Exif\0\0"), Buffer.from([0xff, 0xda, 0x00, 0x02, 0xff, 0xd9])]);

  beforeAll(async () => {
    mkdirSync(`${root}renders`, { recursive: true });
    server = createServer((req, res) => void handle(rt, req, res, guard));
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
    const a = server.address();
    base = `http://127.0.0.1:${typeof a === "object" && a ? a.port : 0}`;
    process.env.LIKENESS_HSP = "agentic";
    rt = await startRuntime({
      mode: "local",
      root,
      publicUrl: base,
      operator: true,
      verifyIdToken: async (t) => {
        if (!users[t]) throw new Error("bad token");
        return users[t]!;
      },
    });
    delete process.env.LIKENESS_HSP;
  }, 120_000);
  afterAll(() => {
    server?.close();
    rt?.stop();
    rmSync(root, { recursive: true, force: true });
  });

  it("signs in, onboards a creator and registers it on chain with its own wallet", async () => {
    expect((await call(null, "/api/me")).body).toEqual({ account: null });
    expect((await call("nobody", "/api/me")).status).toBe(401);
    expect((await call("creator", "/api/me")).body.account.role).toBeNull();
    expect((await call("creator", "/api/me/role", { role: "creator" })).body.creator.address).toMatch(/^0x[0-9a-fA-F]{40}$/);
    expect((await call("creator", "/api/me/role", { role: "brand" })).status).toBe(409); // a role is chosen once
    expect((await call("creator", "/api/me/creator/register", { price: "0.03", categories: [256], maxRenders: 5, adult: true })).body.error).toMatch(/YouTube/);

    await rt.onboarding.connectYoutube("u-creator", { id: "UC-test", title: "Test channel", thumbnail: null });
    expect((await call("creator", "/api/me/creator/photo", { data: jpeg.toString("base64"), consent: false })).status).toBe(400);
    expect((await call("creator", "/api/me/creator/photo", { data: Buffer.from("<svg/>").toString("base64"), consent: true })).status).toBe(415);
    const me = (await call("creator", "/api/me/creator/photo", { data: jpeg.toString("base64"), consent: true })).body;
    const file = readdirSync(`${root}accounts/local/photos`)[0]!;
    expect(readFileSync(`${root}accounts/local/photos/${file}`).includes(Buffer.from("Exif"))).toBe(false);
    expect((await fetch(`${base}${me.creator.photo}`)).status).toBe(404); // not public before registering

    expect((await call("creator", "/api/me/creator/register", { price: "0.10", categories: [256], maxRenders: 5, adult: true })).status).toBe(400);
    expect((await call("creator", "/api/me/creator/register", { price: "0.03", categories: [256], maxRenders: 5, adult: false })).status).toBe(400);
    const reg = await call("creator", "/api/me/creator/register", { price: "0.03", categories: [256, 512], maxRenders: 5, adult: true });
    expect(reg.status).toBe(200);
    expect(reg.body.creator.registeredTx).toMatch(/^0x/);
    expect(reg.body.creator.agentTx).toMatch(/^0x/);

    const addr = reg.body.creator.address.toLowerCase();
    const list = (await call(null, "/api/creators")).body;
    expect(list).toHaveLength(2);
    expect(list[1]).toMatchObject({ synthetic: false, name: "Rohit (test)", label: "local devnet", terms: { price: "0.03", maxRenders: 5 } });
    expect((await fetch(`${base}/api/creators/${addr}/photo`)).headers.get("content-type")).toBe("image/jpeg");
    expect((await call(null, `/api/agents/${addr}/.well-known/agent-card.json`)).body.url).toBe(`${base}/api/agents/${addr}/a2a`);
  }, 120_000);

  it("a brand account licenses the creator, pays with both approvals, Verify says Licensed, the creator revokes", async () => {
    const creator = (await call("creator", "/api/me")).body.creator.address;
    expect((await call(null, "/api/brand/license", { creator })).status).toBe(401);
    expect((await call("creator", "/api/brand/license", { creator })).status).toBe(403);
    await call("brand", "/api/me/role", { role: "brand" });
    await call("other", "/api/me/role", { role: "brand" });

    const { licenceId } = (await call("brand", "/api/brand/license", { creator, renderCap: 3 })).body;
    expect(licenceId).toBeDefined();
    expect((await call("other", "/api/brand/pay", { licenceId })).status).toBe(403);
    expect((await call("brand", "/api/licences?who=brand")).body.map((l: { id: string }) => l.id)).toEqual([licenceId]);
    expect((await call("other", "/api/licences?who=brand")).body).toEqual([]);

    const job = await pay("brand", licenceId);
    expect(job.state).toBe("delivered");
    expect((await call("brand", "/api/me")).body.brand).toEqual({ image: { used: 1, cap: BRAND_CAPS.image }, video: { used: 0, cap: BRAND_CAPS.video } });
    const render = rt.store.read(job.assetHash)!;
    expect(render.bytes.toString()).toContain("data:image/jpeg;base64,");
    expect((await call(null, `/api/verify?hash=${job.assetHash}`)).body.verdict).toBe("Licensed");
    expect((await call("other", "/api/brand/download", { assetHash: job.assetHash })).status).toBe(403);

    expect((await call("brand", "/api/creator/revoke", { licenceId })).status).toBe(403);
    expect((await call("creator", "/api/creator/revoke", { licenceId: "999" })).status).toBe(403); // not their likeness
    expect((await call("creator", "/api/creator/revoke", { licenceId })).status).toBe(200);
    expect((await call("creator", "/api/licences?who=creator")).body[0].status).toBe("Revoked");
    expect((await pay("brand", licenceId)).error).toMatch(/Refused before anything was signed/);
    expect((await call(null, `/api/verify?hash=${job.assetHash}`)).body.verdict).toBe("Revoked");
  }, 180_000);

  it("caps paid renders per brand account", async () => {
    const creator = (await call("creator", "/api/me")).body.creator.address;
    const { licenceId } = (await call("other", "/api/brand/license", { creator, renderCap: 3 })).body;
    for (let i = 0; i < BRAND_CAPS.image; i++) rt.accounts.addAiUse("u-other", "image");
    expect((await call("other", "/api/brand/pay", { licenceId })).body.error).toMatch(/your account has made today's 3 image ads/);
  }, 60_000);

  it("with LIKENESS_DEMO_CREATOR=0 the synthetic creator isn't listed (real creators are)", async () => {
    process.env.LIKENESS_DEMO_CREATOR = "0";
    try {
      const list = (await call(null, "/api/creators")).body;
      expect(list.every((c: { synthetic: boolean }) => !c.synthetic)).toBe(true);
      expect(list.length).toBeGreaterThanOrEqual(1);
      expect((await call(null, `/api/creators/${rt.creator}`)).status).toBe(404);
      expect((await call(null, "/api/state")).body.demoCreator).toBe(false);
      expect((await call(null, "/api/bundles?who=creator")).body).toEqual([]);
    } finally {
      delete process.env.LIKENESS_DEMO_CREATOR;
    }
    expect((await call(null, "/api/state")).body.demoCreator).toBe(true);
  });
});

