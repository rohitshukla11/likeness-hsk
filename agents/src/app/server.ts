// The Likeness demo app: brand console, creator page, Verify, and the creator agent's A2A endpoints.
//
//   pnpm app                       testnet (chain 133) when deployments/testnet.json exists, else local
//   LIKENESS_MODE=local pnpm app   a devnet with throwaway keys and the emulated HSP Gateway
// Operator actions (license, pay, revoke) are on only with LIKENESS_OPERATOR=1 (the default for local
// and testnet) and only from this machine; or, with LIKENESS_PUBLIC=1 (the public server behind Caddy),
// from anyone holding the demo password (see guard.ts: rate limits, one payment at a time, a daily cap).
import { existsSync, readFileSync } from "node:fs";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { extname, join, normalize } from "node:path";
import { fileURLToPath } from "node:url";
import { parseUnits, type Address, type Hex } from "viem";
import { a2aResponse, readBody, sendJson } from "../a2a/server.js";
import { Refused } from "../brand-agent/agent.js";
import { usdValue } from "../hsp/cart.js";
import { claimMessage, ClaimError, verifyClaim } from "./claim.js";
import { MERCHANT_NAME } from "../hsp/agentic/client.js";
import { hspStatuses, PaymentJobs } from "./jobs.js";
import { ADVERTISING, CREATOR_MAX_PRICE, listLicences, listPayments, startRuntime, VIDEO_MULTIPLIER, type Mode, type Runtime } from "./runtime.js";
import { clientIp, guardFromEnv, type Guard } from "./guard.js";
import { deploymentsDir } from "../chain/networks.js";
import { SITE, type Account, type AdKind } from "./accounts.js";
import { bearer } from "./firebase.js";
import { OnboardingError, youtubeChannel } from "./onboarding.js";
import type { PaymentJob } from "./jobs.js";
import { findBundle, issueBundle, listBundles, newBundleId, revokeBundle } from "./bundles.js";
import { promptsFor } from "../ai/generate.js";
import type { RenderRecord } from "./accounts.js";

const root = fileURLToPath(new URL("../../../", import.meta.url));
const publicDir = fileURLToPath(new URL("../../public/", import.meta.url));
const mode = (process.env.LIKENESS_MODE ?? (existsSync(`${root}deployments/testnet.json`) ? "testnet" : "local")) as Mode;
const port = Number(process.env.PORT ?? 8788);
const operator = (process.env.LIKENESS_OPERATOR ?? (mode === "mainnet" ? "0" : "1")) === "1";
const publicUrl = process.env.PUBLIC_URL ?? `http://127.0.0.1:${port}`;
const publicGuard = guardFromEnv(`${deploymentsDir(root)}/${mode}-paid-today.json`);

const TYPES: Record<string, string> = { ".html": "text/html; charset=utf-8", ".css": "text/css", ".js": "text/javascript", ".svg": "image/svg+xml" };
const PAGES: Record<string, string> = { "/": "index.html", "/brand": "brand.html", "/creator": "creator.html", "/verify": "verify.html", "/agent": "agent.html" };
// The same pages under /console, where the public server keeps them beside the web UI (web/).
for (const [p, f] of Object.entries({ ...PAGES })) PAGES[p === "/" ? "/console" : `/console${p}`] = f;

function isLocal(req: IncomingMessage) {
  const a = req.socket.remoteAddress ?? "";
  return a === "127.0.0.1" || a === "::1" || a === "::ffff:127.0.0.1";
}

const json = (res: ServerResponse, status: number, body: unknown) => sendJson(res, status, body);

/** One set of payment jobs per runtime. */
const jobsOf = new WeakMap<Runtime, PaymentJobs>();
const jobs = (rt: Runtime, guard?: Guard) =>
  jobsOf.get(rt) ??
  (jobsOf.set(
    rt,
    new PaymentJobs(rt, (job: PaymentJob) => {
      guard?.cap.add();
      if (job.owner) rt.accounts.addPaid(job.owner);
      rt.accounts.addAiUse(job.owner ?? "operator", job.kind);
    }),
  ),
  jobsOf.get(rt)!);

/** Ads a day (UTC) per signed-in brand account (they share the demo agent wallet) and across the server. */
export const BRAND_CAPS: Record<AdKind, number> = { image: Number(process.env.LIKENESS_BRAND_IMAGES ?? 3), video: Number(process.env.LIKENESS_BRAND_VIDEOS ?? 1) };
export const SITE_CAPS: Record<AdKind, number> = { image: Number(process.env.LIKENESS_SITE_IMAGES ?? 10), video: Number(process.env.LIKENESS_SITE_VIDEOS ?? 2) };
const kindOf = (v: unknown): AdKind => (v === "video" ? "video" : "image");
const EXT: Record<string, string> = { "image/svg+xml": ".svg", "image/jpeg": ".jpg", "image/png": ".png", "video/mp4": ".mp4" };

/** Why another ad of this kind can't be made today, or null. Checked before any payment. */
function capRefusal(rt: Runtime, kind: AdKind, uid: string | undefined): string | null {
  const what = kind === "video" ? "video ads" : "image ads";
  if (uid && rt.accounts.aiUsed(uid, kind) >= BRAND_CAPS[kind]) return `your account has made today's ${BRAND_CAPS[kind]} ${what} (UTC day); try again after 00:00 UTC`;
  if (rt.accounts.aiUsed(SITE, kind) >= SITE_CAPS[kind]) return `Likeness has made today's ${SITE_CAPS[kind]} ${what} across all brands; try again after 00:00 UTC`;
  return null;
}

/** The brief's safety check (banned uses, fit with advertising), when AI generation is on. */
async function briefRefusal(rt: Runtime, brief: string): Promise<string | null> {
  if (!rt.ai) return null;
  const c = await rt.ai.check(brief);
  return c.allowed ? null : `the brief was refused: ${c.reasons.join("; ")}`;
}
const ADDRESS = /^0x[0-9a-fA-F]{40}$/;
const CATEGORY_BITS = [1 << 8, 1 << 9, 1 << 10, 1 << 11, 1 << 12];

/**
 * Ana Reyes, the synthetic demo creator, is listed unless LIKENESS_DEMO_CREATOR=0 (the public server lists
 * real creators only). Her licences and receipts stay on chain and Verify still answers for her files.
 */
const showDemoCreator = () => process.env.LIKENESS_DEMO_CREATOR !== "0";

/** A creator as the web UI shows it: on-chain terms, plus the profile kept on this server. */
async function creatorView(rt: Runtime, address: Address) {
  const ana = address.toLowerCase() === rt.creator.toLowerCase();
  if (ana && !showDemoCreator()) return undefined;
  const row = ana ? undefined : rt.accounts.creatorByAddress(address);
  if (!ana && !row?.registeredTx) return undefined;
  const [t, payout] = await Promise.all([rt.chain.terms(address), rt.chain.payoutOf(address)]);
  return {
    address,
    synthetic: ana,
    name: row?.name ?? null,
    label: row?.label ?? null,
    photo: row?.photoFile && row.consentAt ? `/api/creators/${address.toLowerCase()}/photo` : null,
    youtube: row?.youtubeChannelId ? { channelId: row.youtubeChannelId, title: row.youtubeTitle, thumbnail: row.youtubeThumbnail, verifiedAt: row.youtubeVerifiedAt } : null,
    agentCard: ana ? "/.well-known/agent-card.json" : `/api/agents/${address.toLowerCase()}/.well-known/agent-card.json`,
    registeredTx: row?.registeredTx ?? null,
    payout,
    terms: { pricePerRender: t.pricePerRender.toString(), price: usdValue(t.pricePerRender), maxRenders: t.maxRenders, categories: t.categories, autoApprove: t.autoApprove },
  };
}

/** The signed-in account, with its creator profile or brand caps. */
function meView(rt: Runtime, me: Account) {
  const c = rt.accounts.creator(me.uid);
  return {
    account: me,
    creator: c
      ? {
          address: c.address,
          name: c.name,
          label: c.label,
          youtube: c.youtubeChannelId ? { channelId: c.youtubeChannelId, title: c.youtubeTitle, thumbnail: c.youtubeThumbnail } : null,
          photo: c.photoFile ? `/api/creators/${c.address.toLowerCase()}/photo` : null,
          consentAt: c.consentAt,
          payout: c.payout,
          registeredTx: c.registeredTx,
          agentTx: c.agentTx,
        }
      : null,
    brand: me.role === "brand" ? { image: { used: rt.accounts.aiUsed(me.uid, "image"), cap: BRAND_CAPS.image }, video: { used: rt.accounts.aiUsed(me.uid, "video"), cap: BRAND_CAPS.video } } : null,
  };
}

const parse = (raw: string) => {
  try {
    return JSON.parse(raw || "{}") as Record<string, unknown>;
  } catch {
    return {};
  }
};

/** Renders made before render records existed (files on disk only) get a minimal record once. */
async function backfillRenders(rt: Runtime) {
  for (const f of rt.store.list()) {
    if (rt.accounts.render(f.hash)) continue;
    const creator = (await rt.chain.licence(BigInt(f.licenceId))).creator;
    rt.accounts.saveRender({
      assetHash: f.hash,
      licenceId: f.licenceId,
      renderIndex: f.renderIndex,
      kind: f.mime === "video/mp4" ? "video" : "image",
      mime: f.mime,
      size: f.size,
      prompt: null,
      promptSha256: null,
      model: null,
      note: null,
      uid: rt.accounts.licenceOwner(f.licenceId) ?? "operator",
      creator,
      bundleId: rt.accounts.bundleOfLicence(f.licenceId)?.id ?? `L${f.licenceId}`,
      hspTx: null,
      anchorTx: null,
      createdAt: Math.round(f.mtime),
    });
  }
}

/** A render card: the record, plus the licence's status now (a revoked bundle's renders say so). */
async function renderViews(rt: Runtime, rows: RenderRecord[]) {
  const status = new Map<string, string>();
  for (const id of new Set(rows.map((r) => r.licenceId))) status.set(id, await rt.chain.status(BigInt(id)));
  return rows.map((r) => ({
    ...r,
    licenceStatus: status.get(r.licenceId),
    brand: rt.accounts.account(r.uid)?.name ?? null,
    creatorName: rt.accounts.creatorByAddress(r.creator)?.name ?? null,
    hasPoster: r.kind === "video" && !!rt.store.readPoster(r.assetHash as Hex),
  }));
}

/**
 * Licences for the brand or creator pages: a signed-in brand sees the licences it took (brands share the
 * demo agent wallet on chain); a signed-in creator sees its own likeness's; otherwise the brand wallet's,
 * or the creator named by ?creator= (default Ana Reyes).
 */
async function scopedLicences(rt: Runtime, url: URL, me: Account | undefined, isOperator: boolean) {
  const withKind = <T extends { id: string }>(ls: T[]) => ls.map((l) => ({ ...l, kind: rt.accounts.licenceMeta(l.id)?.kind ?? "image", brief: rt.accounts.licenceMeta(l.id)?.brief ?? null }));
  return withKind(await scopedLicenceList(rt, url, me, isOperator));
}

async function scopedLicenceList(rt: Runtime, url: URL, me: Account | undefined, isOperator: boolean) {
  if (url.searchParams.get("who") === "brand") {
    const all = await listLicences(rt, { licensee: rt.brandAddress });
    if (isOperator || me?.role !== "brand") return all;
    const mine = rt.accounts.licencesOf(me.uid);
    return all.filter((l) => mine.has(l.id));
  }
  const q = url.searchParams.get("creator");
  const own = me?.role === "creator" ? rt.accounts.creator(me.uid)?.address : undefined;
  const creator = (q && ADDRESS.test(q) ? q : (own ?? rt.creator)) as Address;
  return listLicences(rt, { creator });
}

export async function handle(rt: Runtime, req: IncomingMessage, res: ServerResponse, guard: Guard | undefined = publicGuard) {
  const url = new URL(req.url ?? "/", "http://x");
  const path = url.pathname;
  const ip = guard ? clientIp(req) : "";
  if (guard && !guard.reads.allow(ip)) return json(res, 429, { error: "too many requests from this address; try again in a minute" });
  // A creator's photo arrives as base64 JSON (up to 3 MB of image).
  const raw = req.method === "POST" ? await readBody(req, path === "/api/me/creator/photo" ? 5 << 20 : undefined) : "";
  // The operator (admin): this machine, or (public server) a session from the demo password.
  const isOperator = rt.operator && (guard ? guard.auth.check(req) : isLocal(req));
  // Google sign-in: a verified Firebase ID token; the account is created on first sign-in.
  let me: Account | undefined;
  const token = bearer(req);
  if (token) {
    try {
      me = rt.accounts.upsert(await rt.verifyIdToken(token));
    } catch {
      return json(res, 401, { error: "your sign-in has expired or isn't valid; sign in with Google again" });
    }
  }

  // ---------------------------------------------------------------- the creator agent (public)
  if (req.method === "GET" && path === "/.well-known/agent-card.json") return json(res, 200, rt.creatorAgent.card());
  if (req.method === "POST" && path === "/a2a") return json(res, 200, await a2aResponse(rt.creatorAgent, raw));
  // Registered creators' agents: the shared creator agent, at each creator's own endpoint.
  const ag = /^\/api\/agents\/(0x[0-9a-fA-F]{40})\/(\.well-known\/agent-card\.json|a2a)$/.exec(path);
  if (ag) {
    const agent = rt.agentFor(ag[1] as Address);
    if (!agent) return json(res, 404, { error: "no such creator agent" });
    if (req.method === "GET" && ag[2] !== "a2a") return json(res, 200, agent.card());
    if (req.method === "POST" && ag[2] === "a2a") return json(res, 200, await a2aResponse(agent, raw));
  }
  if (req.method === "POST" && path === "/hsp/webhook") {
    const sig = req.headers["x-signature"];
    const r = rt.creatorAgent.handleWebhook(raw, Array.isArray(sig) ? sig[0] : sig);
    return json(res, r.status, r.body);
  }

  // ---------------------------------------------------------------- the demo password (public server)
  if (req.method === "POST" && (path === "/api/login" || path === "/api/logout")) {
    if (!guard) return json(res, 404, { error: "not found" });
    if (path === "/api/logout") {
      res.setHeader("set-cookie", guard.auth.logout());
      return json(res, 200, { ok: true });
    }
    if (!guard.logins.allow(ip)) return json(res, 429, { error: "too many attempts; try again in a minute" });
    const cookie = guard.auth.login(String(parse(raw).password ?? ""));
    if (!cookie) return json(res, 401, { error: "wrong demo password" });
    res.setHeader("set-cookie", cookie);
    return json(res, 200, { ok: true });
  }

  // ---------------------------------------------------------------- pages and assets
  if (req.method === "GET" && (PAGES[path] || path.startsWith("/static/"))) {
    const file = PAGES[path] ?? normalize(path.slice("/static/".length)).replace(/^(\.\.[/\\])+/, "");
    try {
      const body = readFileSync(join(publicDir, file));
      res.writeHead(200, { "content-type": TYPES[extname(file)] ?? "application/octet-stream", "cache-control": "no-store" });
      return res.end(body);
    } catch {
      return json(res, 404, { error: "not found" });
    }
  }

  // ---------------------------------------------------------------- read-only API (public)
  const d = rt.chain.d;
  if (req.method === "GET" && path === "/api/state") {
    const t = await rt.chain.terms(rt.creator);
    return json(res, 200, {
      mode: rt.mode,
      gateway: rt.gateway,
      renderer: rt.renderer,
      operator: isOperator,
      // The public server asks for the demo password; caps are shown so nobody is surprised by a refusal.
      login: guard ? { required: true } : null,
      policy: { maxPricePerRender: usdValue(rt.brand.budget.policy.maxPricePerRender), dailyBudget: usdValue(rt.brand.budget.policy.dailyBudget) },
      cap: guard ? { max: guard.cap.max, paidToday: guard.cap.count() } : null,
      // Google sign-in for brands and creators; the demo password is the admin fallback.
      signIn: { google: true },
      demoCreator: showDemoCreator(),
      // AI ads (Vertex AI) or TEST RENDER; caps per brand account and across the server, per UTC day.
      ads: {
        ai: !!rt.ai,
        videoMultiplier: Number(VIDEO_MULTIPLIER),
        brandCaps: BRAND_CAPS,
        siteCaps: SITE_CAPS,
        usedToday: { image: rt.accounts.aiUsed(SITE, "image"), video: rt.accounts.aiUsed(SITE, "video") },
      },
      chainId: d.chainId,
      explorer: d.explorer ?? null,
      contracts: { creators: d.creators, licences: d.licences, receipts: d.receipts, settlement: d.settlement, token: d.token },
      token: d.tokenSymbol,
      rail: d.rail,
      creator: rt.creator,
      payout: await rt.chain.payoutOf(rt.creator),
      brand: rt.brandAddress,
      terms: { pricePerRender: t.pricePerRender.toString(), price: usdValue(t.pricePerRender), maxRenders: t.maxRenders, categories: t.categories, autoApprove: t.autoApprove },
      spentToday: rt.brand.budget.spentToday.toString(),
      // HSP Agentic Payment: where it runs, the network and token from get_chain_config, our team name.
      agentic: rt.agentic ? { source: rt.agentic.source, network: rt.agentic.option.network, chainId: rt.agentic.option.chainId, token: rt.agentic.option.token, recordable: rt.agentic.recordable, merchantName: MERCHANT_NAME } : null,
    });
  }
  if (req.method === "GET" && path === "/api/log") return json(res, 200, rt.log.since(Number(url.searchParams.get("since") ?? 0)));
  if (req.method === "GET" && path === "/api/creators") {
    const all = [...(showDemoCreator() ? [rt.creator] : []), ...rt.accounts.registeredCreators().map((c) => c.address as Address)];
    return json(res, 200, (await Promise.all(all.map((a) => creatorView(rt, a)))).filter(Boolean));
  }
  const cr = /^\/api\/creators\/(0x[0-9a-fA-F]{40})(\/photo)?$/.exec(path);
  if (req.method === "GET" && cr) {
    if (cr[2]) {
      // Shown only after the creator ticked the consent box; their own photo is visible to them before registering.
      const row = rt.accounts.creatorByAddress(cr[1]!);
      const photo = row && (row.registeredTx || row.uid === me?.uid) && row.consentAt ? rt.onboarding.photo(row) : undefined;
      if (!photo) return json(res, 404, { error: "no photo" });
      res.writeHead(200, { "content-type": photo.mime, "cache-control": "no-cache", "x-content-type-options": "nosniff" });
      return res.end(photo.bytes);
    }
    const v = await creatorView(rt, cr[1] as Address);
    return v ? json(res, 200, v) : json(res, 404, { error: "no such creator" });
  }

  // ---------------------------------------------------------------- the signed-in account (Google)
  if (path === "/api/me" || path.startsWith("/api/me/")) {
    if (!me) return json(res, token ? 401 : 200, token ? { error: "sign in with Google" } : { account: null });
    if (req.method === "GET" && path === "/api/me") return json(res, 200, meView(rt, me));
    if (req.method !== "POST") return json(res, 404, { error: "not found" });
    if (guard && !guard.actions.allow(ip)) return json(res, 429, { error: "too many actions from this address; try again in a minute" });
    const body = parse(raw);
    try {
      if (path === "/api/me/role") {
        const role = body.role;
        if (role !== "brand" && role !== "creator") return json(res, 400, { error: "role is brand or creator" });
        if (me.role && me.role !== role) return json(res, 409, { error: `this account is already a ${me.role}; use another Google account for the other role` });
        me = rt.accounts.setRole(me.uid, role);
        if (role === "creator") rt.onboarding.start(me.uid, me.name);
        return json(res, 200, meView(rt, me));
      }
      if (path.startsWith("/api/me/creator/")) {
        if (me.role !== "creator") return json(res, 403, { error: "choose Creator first" });
        rt.onboarding.start(me.uid, me.name);
        if (path === "/api/me/creator/youtube") {
          await rt.onboarding.connectYoutube(me.uid, await youtubeChannel(String(body.accessToken ?? ""), me.email));
          return json(res, 200, meView(rt, me));
        }
        if (path === "/api/me/creator/photo") {
          rt.onboarding.savePhoto(me.uid, Buffer.from(String(body.data ?? ""), "base64"), body.consent === true);
          return json(res, 200, meView(rt, me));
        }
        if (path === "/api/me/creator/register") {
          const price = parseUnits(String(body.price ?? "0"), 6);
          // Within what the demo brand agent will pay, or no brand could license this creator.
          if (price <= 0n || price > CREATOR_MAX_PRICE) return json(res, 400, { error: `price must be above 0 and at most ${usdValue(CREATOR_MAX_PRICE)} per render on this demo` });
          const cats = Array.isArray(body.categories) ? (body.categories as unknown[]).map(Number) : [];
          if (!cats.length || cats.some((c) => !CATEGORY_BITS.includes(c))) return json(res, 400, { error: "choose at least one allowed use" });
          const maxRenders = Number(body.maxRenders ?? 0);
          if (!Number.isInteger(maxRenders) || maxRenders < 1 || maxRenders > 10) return json(res, 400, { error: "render cap is 1 to 10 per licence" });
          const payout = body.payout ? String(body.payout) : undefined;
          if (payout && !ADDRESS.test(payout)) return json(res, 400, { error: "payout must be a 0x address" });
          await rt.onboarding.register(me.uid, { priceUnits: price, categories: cats.reduce((a, c) => a | c, 0), maxRenders, payout: payout as Address | undefined }, body.adult === true);
          return json(res, 200, meView(rt, me));
        }
      }
    } catch (e) {
      if (e instanceof OnboardingError) return json(res, e.status, { error: e.message });
      return json(res, 500, { error: (e as Error).message.split("\n")[0] });
    }
    return json(res, 404, { error: "not found" });
  }
  if (req.method === "GET" && path === "/api/licences") return json(res, 200, await scopedLicences(rt, url, me, isOperator));
  // Galleries: a brand sees its own renders; a creator, every render of their own likeness; the operator,
  // all of them (and the disk they use). Nothing here is public: anyone else checks a file on Verify.
  if (req.method === "GET" && path === "/api/renders") {
    await backfillRenders(rt);
    if (url.searchParams.get("who") === "creator") {
      const own = me?.role === "creator" ? rt.accounts.creator(me.uid)?.address : undefined;
      if (own) return json(res, 200, { renders: await renderViews(rt, rt.accounts.renders({ creator: own })) });
      if (isOperator) return json(res, 200, { renders: await renderViews(rt, rt.accounts.renders({ creator: rt.creator })) });
      return json(res, me ? 403 : 401, { error: me ? "only the creator sees renders of their likeness" : "sign in with Google" });
    }
    if (isOperator) return json(res, 200, { renders: await renderViews(rt, rt.accounts.renders()), totalBytes: rt.store.totalBytes() });
    if (me?.role === "brand") return json(res, 200, { renders: await renderViews(rt, rt.accounts.renders({ uid: me.uid })) });
    return json(res, me ? 403 : 401, { error: me ? "only brand accounts have renders" : "sign in with Google" });
  }
  const media = /^\/api\/renders\/(0x[0-9a-fA-F]{64})\/(file|poster)$/.exec(path);
  if (req.method === "GET" && media) {
    const r = rt.accounts.render(media[1]!);
    const own = me?.role === "creator" ? rt.accounts.creator(me.uid)?.address : undefined;
    const allowed = !!r && (isOperator || (me?.role === "brand" && r.uid === me.uid) || (!!own && own.toLowerCase() === r.creator.toLowerCase()));
    if (!allowed) return json(res, me || isOperator ? 403 : 401, { error: me || isOperator ? "not your render" : "sign in with Google" });
    const bytes = media[2] === "poster" ? rt.store.readPoster(media[1] as Hex) : rt.store.read(media[1] as Hex)?.bytes;
    if (!bytes) return json(res, 404, { error: "not stored on this server" });
    res.writeHead(200, { "content-type": media[2] === "poster" ? "image/jpeg" : r!.mime, "cache-control": "private, max-age=3600", "x-content-type-options": "nosniff" });
    return res.end(bytes);
  }
  if (req.method === "GET" && path === "/api/bundles") {
    if (url.searchParams.get("who") === "brand") {
      return json(res, 200, me?.role === "brand" && !isOperator ? await listBundles(rt, { uid: me.uid }) : await listBundles(rt, { operator: true }));
    }
    const q = url.searchParams.get("creator");
    const own = me?.role === "creator" ? rt.accounts.creator(me.uid)?.address : undefined;
    const creator = q && ADDRESS.test(q) ? q : (own ?? (showDemoCreator() || isOperator ? rt.creator : undefined));
    return json(res, 200, creator ? await listBundles(rt, { creator: creator as Address }) : []);
  }
  if (req.method === "GET" && path === "/api/trace") {
    // The log events of one paid render: from the brand's A2A request for it to its receipt.
    const l = url.searchParams.get("licenceId");
    const r = url.searchParams.get("renderIndex");
    const ev = rt.log.events;
    const end = ev.findLastIndex((e) => e.kind === "tx" && e.summary === `receipt anchored for render ${r} of licence ${l}`);
    if (end < 0) return json(res, 404, { error: "no trace for this render in this server's log" });
    let start = end;
    while (start > 0 && !(ev[start]!.kind === "a2a.request" && ev[start]!.actor === "brand-agent" && JSON.stringify(ev[start]!.data).includes(`"licenceId":"${l}"`))) start--;
    return json(res, 200, ev.slice(start, end + 1));
  }
  if (req.method === "GET" && path === "/api/payments") {
    const mine = await scopedLicences(rt, url, me, isOperator);
    return json(res, 200, await listPayments(rt, { licenceIds: new Set(mine.map((l) => l.id)) }));
  }
  if (req.method === "GET" && path === "/api/verify") {
    const hash = url.searchParams.get("hash") as Hex | null;
    if (!hash || !/^0x[0-9a-fA-F]{64}$/.test(hash)) return json(res, 400, { error: "hash must be a 0x-prefixed sha256" });
    const [found, r] = await rt.chain.receiptOf(hash);
    if (!found) return json(res, 200, { verdict: "Unknown", reason: "no receipt for these exact bytes (edited, re-encoded or never licensed)" });
    const [lic, status, payment, recorded] = await Promise.all([
      rt.chain.licence(r.licenceId),
      rt.chain.status(r.licenceId),
      rt.chain.payment(r.licenceId, r.renderIndex),
      listPayments(rt, { licenceId: r.licenceId, renderIndex: r.renderIndex }),
    ]);
    const verdict = status === "Revoked" ? "Revoked" : status === "Expired" ? "Expired" : "Licensed";
    return json(res, 200, {
      verdict,
      licenceStatus: status,
      licenceId: r.licenceId.toString(),
      renderIndex: r.renderIndex,
      anchoredAt: Number(r.timestamp),
      creator: lic.creator,
      licensee: lic.licensee,
      paid: usdValue(payment.amount),
      hspTxHash: payment.hspTxHash,
      nonceBound: payment.nonceBound,
      paidAt: Number(payment.recordedAt),
      recordTx: recorded[0]?.recordTx ?? null,
      anchorTx: recorded[0]?.anchorTx ?? null,
      licenceEnd: Number(lic.end),
      // What was generated: the render record's exact prompt and its sha256 (no file or brand data beyond that).
      render: (() => {
        const rec = rt.accounts.render(hash);
        return rec ? { kind: rec.kind, prompt: rec.prompt, promptSha256: rec.promptSha256, model: rec.model, createdAt: rec.createdAt } : null;
      })(),
      // The licence bundle this file was made under: one licence per media type on chain.
      bundle: (() => {
        const b = rt.accounts.bundleOfLicence(r.licenceId.toString());
        return b ? { id: b.id, brief: b.brief, brand: rt.accounts.account(b.uid)?.name ?? null, imageLicence: b.imageLicence, videoLicence: b.videoLicence, kind: b.videoLicence === r.licenceId.toString() ? "video" : "image" } : null;
      })(),
    });
  }

  // ---------------------------------------------------------------- downloads need the licensee's signature
  const dl = /^\/api\/renders\/(0x[0-9a-fA-F]{64})$/.exec(path);
  if (req.method === "GET" && dl) {
    // The message to sign (public): the client signs it with the licensee wallet.
    const [found, r] = await rt.chain.receiptOf(dl[1] as Hex);
    if (!found) return json(res, 404, { error: "no receipt for this file" });
    const issuedAt = new Date().toISOString();
    return json(res, 200, { issuedAt, message: claimMessage({ assetHash: dl[1] as Hex, licenceId: r.licenceId, chainId: d.chainId, issuedAt }) });
  }
  if (req.method === "POST" && dl) {
    const body = JSON.parse(raw || "{}") as { issuedAt?: string; signature?: Hex };
    try {
      await verifyClaim(rt.chain, { assetHash: dl[1] as Hex, issuedAt: body.issuedAt ?? "", signature: body.signature ?? "0x" });
    } catch (e) {
      if (e instanceof ClaimError) return json(res, e.status, { error: e.message });
      throw e;
    }
    const file = rt.store.read(dl[1] as Hex);
    if (!file) return json(res, 404, { error: "file not stored on this server" });
    res.writeHead(200, { "content-type": file.mime, "content-disposition": `attachment; filename="${dl[1]}${EXT[file.mime] ?? ""}"` });
    return res.end(file.bytes);
  }

  // ---------------------------------------------------------------- operator actions (this machine only)
  if (path.startsWith("/api/brand/") || path.startsWith("/api/creator/")) {
    if (!rt.operator) return json(res, 403, { error: "operator actions are off on this server" });
    const role = path.startsWith("/api/brand/") ? "brand" : "creator";
    // A signed-in brand acts for itself (licences it took); a signed-in creator revokes its own licences.
    const acct = !isOperator && me?.role === role ? me : undefined;
    if (!isOperator && !acct) {
      if (me) return json(res, 403, { error: `this needs a ${role} account; yours is ${me.role ? `a ${me.role}` : "not set up yet"}` });
      return json(res, guard ? 401 : 403, { error: guard ? "sign in with Google first" : "operator actions are off on this server" });
    }
    if (guard && req.method === "POST" && !guard.actions.allow(ip)) return json(res, 429, { error: "too many operator actions from this address; try again in a minute" });
    const body = JSON.parse(raw || "{}") as Record<string, string>;
    const ownsLicence = (id: string | bigint) => !acct || rt.accounts.licenceOwner(String(id)) === acct.uid;
    try {
      if (req.method === "GET" && path === "/api/brand/prompt") {
        // The exact text that would be sent to the model(s), pre-filled from the bundle's brief; editable.
        const licenceId = url.searchParams.get("licenceId") ?? "0";
        if (!ownsLicence(licenceId)) return json(res, 403, { error: "this licence was taken by another brand account" });
        const meta = rt.accounts.licenceMeta(licenceId) ?? { kind: "image" as const, brief: "demo ad" };
        return json(res, 200, { kind: meta.kind, brief: meta.brief, ...promptsFor(meta.kind, meta.brief) });
      }
      if (req.method === "POST" && (path === "/api/brand/bundle" || path === "/api/brand/bundle/retry")) {
        let bundle;
        if (path === "/api/brand/bundle") {
          const creator = (body.creator && ADDRESS.test(body.creator) ? body.creator : rt.creator) as Address;
          const images = Number(body.images ?? 0);
          const videos = Number(body.videos ?? 0);
          const terms = await rt.chain.terms(creator);
          if (![images, videos].every(Number.isInteger) || images < 0 || images > 5 || videos < 0 || videos > 2) return json(res, 400, { error: "images 0 to 5, videos 0 to 2" });
          if (images + videos === 0) return json(res, 400, { error: "ask for at least one image or video" });
          if (images > terms.maxRenders || videos > terms.maxRenders) return json(res, 400, { error: `this creator allows at most ${terms.maxRenders} renders per licence` });
          const brief = String(body.brief ?? "").trim();
          // The brief is checked once, before anything is issued or paid.
          const refused = (brief.length < 3 ? "write a short brief: product, setting, style" : null) ?? (await briefRefusal(rt, brief));
          if (refused) return json(res, 422, { error: refused });
          bundle = rt.accounts.createBundle({ id: newBundleId(), uid: acct?.uid ?? "operator", creator, brief, images, videos, duration: Number(body.durationSeconds ?? 7 * 86400) });
        } else {
          bundle = rt.accounts.bundle(String(body.bundleId ?? ""));
          if (!bundle || (acct && bundle.uid !== acct.uid)) return json(res, 404, { error: "no such bundle" });
        }
        const out = await issueBundle(rt, bundle);
        const view = (await listBundles(rt, acct ? { uid: acct.uid } : { operator: true })).find((b) => b.id === bundle.id);
        return json(res, 200, { bundle: view, ...(out.error ? { error: out.error } : {}) });
      }
      if (req.method === "POST" && path === "/api/brand/license") {
        const creator = (body.creator && ADDRESS.test(body.creator) ? body.creator : rt.creator) as Address;
        // Image or video ads; a video licence pays VIDEO_MULTIPLIER renders' worth per render.
        const kind = kindOf(body.kind);
        const brief = String(body.brief ?? body.purpose ?? "").trim() || "demo campaign";
        const refused = await briefRefusal(rt, brief);
        if (refused) return json(res, 422, { error: refused });
        const conn = await rt.connectTo(creator);
        const id = await rt.brand.license(conn, {
          category: ADVERTISING,
          regions: 1,
          durationSeconds: BigInt(body.durationSeconds ?? 7 * 86400),
          renderCap: Number(body.renderCap ?? 3),
          purpose: `${kind} ad: ${brief}`,
          priceMultiplier: kind === "video" ? VIDEO_MULTIPLIER : 1n,
        });
        rt.accounts.recordLicence(id.toString(), acct?.uid ?? "operator", creator);
        rt.accounts.setLicenceMeta(id.toString(), kind, brief);
        return json(res, 200, { licenceId: id.toString(), kind });
      }
      if (req.method === "POST" && path === "/api/brand/pay") {
        // Runs in the background: the console polls the job, shows the approvals and HSP's statuses.
        if (!ownsLicence(body.licenceId ?? "0")) return json(res, 403, { error: "this licence was taken by another brand account" });
        // Before any order or signature: today's caps for this kind of ad, and the brief's safety check.
        const meta = rt.accounts.licenceMeta(String(body.licenceId ?? "0")) ?? { kind: "image" as const, brief: "demo ad" };
        const brief = String(body.brief ?? "").trim() || meta.brief;
        // The prompt(s) the brand approved (edited or not); the template from the brief otherwise.
        const template = promptsFor(meta.kind, brief);
        const prompts = { prompt: String(body.prompt ?? "").trim() || template.prompt, ...(meta.kind === "video" ? { motion: String(body.motion ?? "").trim() || template.motion! } : {}) };
        if (prompts.prompt.length > 3000 || (prompts.motion ?? "").length > 2000) return json(res, 400, { error: "the prompt is too long" });
        // A revoked, expired or used-up licence goes straight to the brand agent's refusal (nothing signed);
        // caps and the brief check apply to licences that can still be paid.
        if ((await rt.chain.status(BigInt(body.licenceId ?? "0"))) === "Active") {
          const capped = capRefusal(rt, meta.kind, acct?.uid);
          if (capped) return json(res, 429, { error: capped });
          // The creator's allowed uses (they may have changed their terms since the licence) and the
          // prompt's own check: banned uses and fit with advertising. Nothing is signed if either fails.
          const creator = (await rt.chain.licence(BigInt(body.licenceId ?? "0"))).creator;
          if (((await rt.chain.terms(creator)).categories & ADVERTISING) !== ADVERTISING) return json(res, 409, { error: "the creator no longer allows advertising: nothing was signed" });
          for (const text of [prompts.prompt, prompts.motion].filter(Boolean) as string[]) {
            const refused = await briefRefusal(rt, text);
            if (refused) return json(res, 422, { error: refused.replace("the brief was refused", "the prompt was refused, nothing was signed") });
          }
        }
        if (guard) {
          if ([...jobs(rt, guard).jobs.values()].some((j) => j.state === "paying")) return json(res, 409, { error: "another payment is in progress; try again when it finishes" });
          if (guard.cap.count() >= guard.cap.max) return json(res, 429, { error: `today's cap is reached: ${guard.cap.max} paid renders a day (UTC)` });
        }
        const job = jobs(rt, guard).start(BigInt(body.licenceId ?? "0"), brief, acct?.uid, meta.kind, prompts);
        return json(res, 200, { jobId: job.id, fromSeq: rt.log.events.at(-1)?.seq ?? 0 });
      }
      if (req.method === "GET" && path === "/api/brand/job") {
        const job = jobs(rt, guard).jobs.get(url.searchParams.get("id") ?? "");
        if (!job || (acct && job.owner !== acct.uid)) return json(res, 404, { error: "no such payment" });
        const statuses = hspStatuses(rt.log, job.flowId);
        const last = statuses.at(-1);
        return json(res, 200, { job, approvals: rt.approvals.list(), statuses, tx: job.hspTx ?? last?.tx ?? null, attribution: last?.attribution ?? null, toSeq: rt.log.events.at(-1)?.seq ?? 0 });
      }
      if (req.method === "POST" && path === "/api/brand/approve") {
        // The pending approvals belong to the payment in progress: only its brand account answers them.
        if (acct && ![...jobs(rt, guard).jobs.values()].some((j) => j.state === "paying" && j.owner === acct.uid)) return json(res, 403, { error: "no payment of yours is waiting for approval" });
        const ok = rt.approvals.decide(String(body.id ?? ""), body.decision === "approve");
        return ok ? json(res, 200, { ok: true }) : json(res, 409, { error: "this approval is no longer pending (answered, or its quote expired)" });
      }
      if (req.method === "POST" && path === "/api/brand/deliver") {
        // A render that was paid and recorded but not yet delivered (e.g. recorded by `pnpm run recover`).
        const id = BigInt(body.licenceId ?? "0");
        const idx = Number(body.renderIndex ?? 0);
        if (!ownsLicence(id)) return json(res, 403, { error: "this licence was taken by another brand account" });
        const p = await rt.chain.payment(id, idx);
        if (p.recordedAt === 0n) return json(res, 409, { error: "not paid" });
        if (p.assetHash !== "0x0000000000000000000000000000000000000000000000000000000000000000") return json(res, 409, { error: "already delivered" });
        const out = await rt.render.renderAndAnchor(id, idx, body.brief ?? "demo ad", rt.subjectOf((await rt.chain.licence(id)).creator));
        rt.store.save(out.assetHash, out.bytes, { mime: out.mime, licenceId: id.toString(), renderIndex: idx });
        return json(res, 200, { assetHash: out.assetHash, anchorTx: out.tx });
      }
      if (req.method === "POST" && path === "/api/brand/download") {
        // The brand agent claims its own render: it signs the claim with the brand wallet, and the
        // server checks it exactly as for anyone else.
        const hash = body.assetHash as Hex;
        const [found, r] = await rt.chain.receiptOf(hash);
        if (!found) return json(res, 404, { error: "no receipt" });
        if (!ownsLicence(r.licenceId)) return json(res, 403, { error: "this render was paid for by another brand account" });
        const issuedAt = new Date().toISOString();
        const signature = await rt.brandAccount().signMessage({ message: claimMessage({ assetHash: hash, licenceId: r.licenceId, chainId: d.chainId, issuedAt }) });
        return json(res, 200, { issuedAt, signature });
      }
      if (req.method === "POST" && path === "/api/creator/revoke" && body.bundleId) {
        // Revoking a bundle revokes each of its licences: one transaction per media type.
        const b = await findBundle(rt, String(body.bundleId));
        if (!b) return json(res, 404, { error: "no such bundle" });
        const row = acct ? rt.accounts.creator(acct.uid) : rt.accounts.creatorByAddress(b.creator);
        if (acct && (!row?.registeredTx || row.address.toLowerCase() !== b.creator.toLowerCase())) return json(res, 403, { error: "you can only revoke licences of your own likeness" });
        const txs = await revokeBundle(rt, b, (id) => (row ? rt.onboarding.revoke(row, id) : rt.revoke(id)));
        return json(res, 200, { txs });
      }
      if (req.method === "POST" && path === "/api/creator/revoke") {
        const id = BigInt(body.licenceId ?? "0");
        if (acct) {
          // Only the creator whose likeness it is, signed by their own wallet.
          const row = rt.accounts.creator(acct.uid);
          if (!row?.registeredTx) return json(res, 403, { error: "finish creator onboarding first" });
          return json(res, 200, { tx: await rt.onboarding.revoke(row, id) });
        }
        const lic = await rt.chain.licence(id);
        const row = rt.accounts.creatorByAddress(lic.creator);
        return json(res, 200, { tx: row ? await rt.onboarding.revoke(row, id) : await rt.revoke(id) });
      }
    } catch (e) {
      if (e instanceof OnboardingError) return json(res, e.status, { error: e.message });
      return json(res, e instanceof Refused ? 409 : 500, { error: (e as Error).message.split("\n")[0] });
    }
  }
  return json(res, 404, { error: "not found" });
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const rt = await startRuntime({ mode, root, publicUrl, operator });
  const server = createServer((req, res) => {
    handle(rt, req, res).catch((e) => json(res, 500, { error: (e as Error).message.split("\n")[0] }));
  });
  server.listen(port, "127.0.0.1", () => {
    console.log(`Likeness app (${mode}, gateway: ${rt.gateway}, operator: ${operator}${publicGuard ? ", public: demo password, rate limits, daily cap" : ""}) on ${publicUrl}`);
  });
  const stop = () => {
    server.close();
    rt.stop();
    process.exit(0);
  };
  process.on("SIGINT", stop);
  process.on("SIGTERM", stop);
}
