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

export function header(active) {
  const links = [["/", "Overview"], ["/brand", "Brand console"], ["/creator", "Creator"], ["/verify", "Verify"]];
  document.body.insertAdjacentHTML(
    "afterbegin",
    `<header><span class="brand">Likeness on HSK Chain</span>${links.map(([h, t]) => `<a href="${h}" class="${h === active ? "on" : ""}">${t}</a>`).join("")}</header>`,
  );
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
