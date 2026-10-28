// The Likeness demo app: brand console, creator page, Verify, and the creator agent's A2A endpoints.
//
//   pnpm app                       testnet (chain 133) when deployments/testnet.json exists, else local
//   LIKENESS_MODE=local pnpm app   a devnet with throwaway keys and the emulated HSP Gateway
// Operator actions (license, pay, revoke) are on only with LIKENESS_OPERATOR=1 (the default for local
// and testnet) and only from this machine.
import { existsSync, readFileSync } from "node:fs";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { extname, join, normalize } from "node:path";
import { fileURLToPath } from "node:url";
import type { Hex } from "viem";
import { a2aResponse, readBody, sendJson } from "../a2a/server.js";
import { Refused } from "../brand-agent/agent.js";
import { usdValue } from "../hsp/cart.js";
import { claimMessage, ClaimError, verifyClaim } from "./claim.js";
import { ADVERTISING, listLicences, listPayments, startRuntime, type Mode, type Runtime } from "./runtime.js";

const root = fileURLToPath(new URL("../../../", import.meta.url));
const publicDir = fileURLToPath(new URL("../../public/", import.meta.url));
const mode = (process.env.LIKENESS_MODE ?? (existsSync(`${root}deployments/testnet.json`) ? "testnet" : "local")) as Mode;
const port = Number(process.env.PORT ?? 8788);
const operator = (process.env.LIKENESS_OPERATOR ?? (mode === "mainnet" ? "0" : "1")) === "1";
const publicUrl = process.env.PUBLIC_URL ?? `http://127.0.0.1:${port}`;

const TYPES: Record<string, string> = { ".html": "text/html; charset=utf-8", ".css": "text/css", ".js": "text/javascript", ".svg": "image/svg+xml" };
const PAGES: Record<string, string> = { "/": "index.html", "/brand": "brand.html", "/creator": "creator.html", "/verify": "verify.html" };

function isLocal(req: IncomingMessage) {
  const a = req.socket.remoteAddress ?? "";
  return a === "127.0.0.1" || a === "::1" || a === "::ffff:127.0.0.1";
}

const json = (res: ServerResponse, status: number, body: unknown) => sendJson(res, status, body);

export async function handle(rt: Runtime, req: IncomingMessage, res: ServerResponse) {
  const url = new URL(req.url ?? "/", "http://x");
  const path = url.pathname;
  const raw = req.method === "POST" ? await readBody(req) : "";

  // ---------------------------------------------------------------- the creator agent (public)
  if (req.method === "GET" && path === "/.well-known/agent-card.json") return json(res, 200, rt.creatorAgent.card());
  if (req.method === "POST" && path === "/a2a") return json(res, 200, await a2aResponse(rt.creatorAgent, raw));
  if (req.method === "POST" && path === "/hsp/webhook") {
    const sig = req.headers["x-signature"];
    const r = rt.creatorAgent.handleWebhook(raw, Array.isArray(sig) ? sig[0] : sig);
    return json(res, r.status, r.body);
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
      operator: rt.operator && isLocal(req),
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
    });
  }
  if (req.method === "GET" && path === "/api/log") return json(res, 200, rt.log.since(Number(url.searchParams.get("since") ?? 0)));
  if (req.method === "GET" && path === "/api/licences") {
    const who = url.searchParams.get("who");
    return json(res, 200, await listLicences(rt, who === "brand" ? { licensee: rt.brandAddress } : { creator: rt.creator }));
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
    const who = url.searchParams.get("who");
    const mine = await listLicences(rt, who === "brand" ? { licensee: rt.brandAddress } : { creator: rt.creator });
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
    res.writeHead(200, { "content-type": file.mime, "content-disposition": `attachment; filename="${dl[1]}${file.mime === "image/svg+xml" ? ".svg" : ""}"` });
    return res.end(file.bytes);
  }

  // ---------------------------------------------------------------- operator actions (this machine only)
  if (path.startsWith("/api/brand/") || path.startsWith("/api/creator/")) {
    if (!rt.operator || !isLocal(req)) return json(res, 403, { error: "operator actions are off on this server" });
    const body = JSON.parse(raw || "{}") as Record<string, string>;
    try {
      if (req.method === "POST" && path === "/api/brand/license") {
        const conn = await rt.connect();
        const id = await rt.brand.license(conn, { category: ADVERTISING, regions: 1, durationSeconds: 7n * 86400n, renderCap: Number(body.renderCap ?? 3), purpose: body.purpose ?? "demo campaign" });
        return json(res, 200, { licenceId: id.toString() });
      }
      if (req.method === "POST" && path === "/api/brand/pay") {
        const conn = await rt.connect();
        const fromSeq = rt.log.events.at(-1)?.seq ?? 0;
        const id = BigInt(body.licenceId ?? "0");
        const paid = await rt.brand.payForRender(conn, id);
        const p = await rt.brand.waitRecorded(id, paid.renderIndex);
        const out = await rt.render.renderAndAnchor(id, paid.renderIndex, body.brief ?? "demo ad");
        rt.store.save(out.assetHash, out.bytes, { mime: out.mime, licenceId: id.toString(), renderIndex: paid.renderIndex });
        return json(res, 200, {
          licenceId: id.toString(),
          renderIndex: paid.renderIndex,
          hspTx: paid.txHash,
          nonceBound: p.nonceBound,
          assetHash: out.assetHash,
          anchorTx: out.tx,
          fromSeq,
          toSeq: rt.log.events.at(-1)?.seq ?? fromSeq,
        });
      }
      if (req.method === "POST" && path === "/api/brand/deliver") {
        // A render that was paid and recorded but not yet delivered (e.g. recorded by `pnpm run recover`).
        const id = BigInt(body.licenceId ?? "0");
        const idx = Number(body.renderIndex ?? 0);
        const p = await rt.chain.payment(id, idx);
        if (p.recordedAt === 0n) return json(res, 409, { error: "not paid" });
        if (p.assetHash !== "0x0000000000000000000000000000000000000000000000000000000000000000") return json(res, 409, { error: "already delivered" });
        const out = await rt.render.renderAndAnchor(id, idx, body.brief ?? "demo ad");
        rt.store.save(out.assetHash, out.bytes, { mime: out.mime, licenceId: id.toString(), renderIndex: idx });
        return json(res, 200, { assetHash: out.assetHash, anchorTx: out.tx });
      }
      if (req.method === "POST" && path === "/api/brand/download") {
        // The brand agent claims its own render: it signs the claim with the brand wallet, and the
        // server checks it exactly as for anyone else.
        const hash = body.assetHash as Hex;
        const [found, r] = await rt.chain.receiptOf(hash);
        if (!found) return json(res, 404, { error: "no receipt" });
        const issuedAt = new Date().toISOString();
        const signature = await rt.brandAccount().signMessage({ message: claimMessage({ assetHash: hash, licenceId: r.licenceId, chainId: d.chainId, issuedAt }) });
        return json(res, 200, { issuedAt, signature });
      }
      if (req.method === "POST" && path === "/api/creator/revoke") {
        const tx = await rt.revoke(BigInt(body.licenceId ?? "0"));
        return json(res, 200, { tx });
      }
    } catch (e) {
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
    console.log(`Likeness app (${mode}, gateway: ${rt.gateway}, operator: ${operator}) on ${publicUrl}`);
  });
  const stop = () => {
    server.close();
    rt.stop();
    process.exit(0);
  };
  process.on("SIGINT", stop);
  process.on("SIGTERM", stop);
}
