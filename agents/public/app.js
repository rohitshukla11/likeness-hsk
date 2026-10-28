// Shared helpers for the Likeness demo pages. No framework, no build step.
export async function api(path, body) {
  const res = await fetch(path, body === undefined ? {} : { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
  return data;
}

export const $ = (sel) => document.querySelector(sel);
export const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
export const short = (h) => (h && h.length > 14 ? `${h.slice(0, 8)}…${h.slice(-6)}` : h || "");

export function txLink(state, tx) {
  if (!tx || tx === "0x") return "";
  return state.explorer ? `<a class="mono" href="${esc(state.explorer)}/tx/${esc(tx)}" target="_blank" rel="noopener">${esc(short(tx))}</a>` : `<span class="mono">${esc(short(tx))}</span>`;
}

export function addrLink(state, a) {
  return state.explorer ? `<a class="mono" href="${esc(state.explorer)}/address/${esc(a)}" target="_blank" rel="noopener">${esc(short(a))}</a>` : `<span class="mono">${esc(short(a))}</span>`;
}

const NETWORK = { 133: "HSK Chain testnet (133)", 177: "HSK Chain mainnet (177)", 31337: "local devnet" };

/** Header, plus a banner that says plainly which chain and which HSP Gateway this server uses. */
export function header(active, state) {
  const links = [["/", "Overview"], ["/brand", "Brand console"], ["/creator", "Creator"], ["/verify", "Verify"]];
  const gw =
    state?.gateway === "hsp"
      ? `HSP Gateway: HashKey (live merchant credentials)`
      : `HSP Gateway: emulated until merchant credentials are issued`;
  const banner = state
    ? `<div class="banner ${state.gateway === "hsp" ? "live" : ""}"><span>${esc(NETWORK[state.chainId] ?? `chain ${state.chainId}`)}</span><span>${esc(gw)}</span><span>renders: ${state.renderer === "gemini" ? "Gemini" : "marked TEST RENDER"}</span></div>`
    : "";
  document.body.insertAdjacentHTML(
    "afterbegin",
    `<header><span class="brand">Likeness on HSK Chain</span>${links.map(([h, t]) => `<a href="${h}" class="${h === active ? "on" : ""}">${t}</a>`).join("")}</header>${banner}`,
  );
}

/** The A2A → AP2 → HSP → chain steps of one paid render, from the message log. */
export const STEPS = [
  { id: "request", title: "A2A request", who: "brand agent → creator agent", match: (e) => e.actor === "brand-agent" && e.kind === "a2a.request" && /render-payment/.test(e.summary) },
  { id: "cart", title: "AP2 Cart Mandate", who: "creator agent, signed with its merchant key", match: (e) => e.kind === "cart-mandate" },
  { id: "order", title: "HSP order created", who: "creator agent → HSP Gateway", match: (e) => e.actor === "hsp-gateway" && e.kind === "hsp.response" && /order created/.test(e.summary) },
  { id: "policy", title: "Policy check", who: "brand agent: price, payee, budget, licence active", match: (e) => e.actor === "brand-agent" && e.kind === "policy" && /cart accepted/.test(e.summary) },
  { id: "mandate", title: "AP2 Payment Mandate", who: "brand agent, signed with the brand wallet", match: (e) => e.kind === "payment-mandate" },
  { id: "gateway", title: "HSP Gateway executes", who: "HSP Gateway verifies and broadcasts", match: (e) => e.actor === "hsp-gateway" && e.kind === "hsp.response" && /Mandate accepted/.test(e.summary), tx: (e) => e.data?.tx_signature },
  { id: "webhook", title: "HSP webhook", who: "HSP Gateway → creator agent (HMAC-signed)", match: (e) => e.kind === "hsp.webhook" },
  { id: "verified", title: "Payment checked", who: "creator agent reads the transfer and nonce", match: (e) => e.actor === "creator-agent" && e.kind === "info" && /verified/.test(e.summary) },
  { id: "recorded", title: "Recorded on chain", who: "HspSettlement.recordPayment", match: (e) => e.kind === "tx" && /recordPayment/.test(e.summary), tx: (e) => e.data?.tx },
  { id: "receipt", title: "Receipt anchored", who: "render agent → ReceiptAnchor", match: (e) => e.kind === "tx" && /receipt anchored/.test(e.summary), tx: (e) => e.data?.tx },
];

export function timeline(state, events) {
  return `<ol class="steps">${STEPS.map((s) => {
    const hits = events.filter(s.match);
    const e = hits[0];
    const tx = e && s.tx ? s.tx(e) : null;
    return `<li class="${e ? "done" : ""}"><div class="t">${esc(s.title)}${hits.length > 1 ? ` <span class="note">×${hits.length}</span>` : ""}</div><div class="note">${esc(s.who)}</div>${
      e ? `<div class="sum">${esc(e.summary)} ${tx ? txLink(state, tx) : ""}</div>` : ""
    }${e && e.data ? `<details><summary>message</summary><pre>${esc(JSON.stringify(e.data, null, 2))}</pre></details>` : ""}</li>`;
  }).join("")}</ol>`;
}

/** Live message log: polls /api/log and appends new events. */
export function startLog(el) {
  let since = 0;
  const tick = async () => {
    try {
      const events = await api(`/api/log?since=${since}`);
      for (const e of events) {
        since = e.seq;
        const div = document.createElement("div");
        div.className = `ev ${e.actor} ${e.kind}`;
        div.innerHTML = `<div class="who">${esc(e.actor)} · ${esc(e.kind)}</div><div class="sum">${esc(e.summary)}</div>${
          e.data && e.data !== null ? `<details><summary>details</summary><pre>${esc(JSON.stringify(e.data, null, 2))}</pre></details>` : ""
        }`;
        el.appendChild(div);
        el.scrollTop = el.scrollHeight;
      }
    } catch {
      /* server restarting */
    }
    setTimeout(tick, 1000);
  };
  tick();
}

export async function sha256Hex(file) {
  const buf = await crypto.subtle.digest("SHA-256", await file.arrayBuffer());
  return `0x${[...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("")}`;
}

export function saveBlob(blob, name) {
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 5000);
}
