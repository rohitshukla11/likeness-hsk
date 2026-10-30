/**
 * The agents backend (agents/src/app/server.ts), proxied by next.config.ts: types of what it returns and
 * small fetch helpers. Every call runs in the browser, with the operator session cookie when unlocked.
 */

export type Gateway = "hsp" | "emulator" | "hsp-agentic-qa" | "hsp-agentic-emulator";

export type State = {
  mode: "local" | "testnet" | "mainnet";
  gateway: Gateway;
  renderer: "gemini" | "test";
  operator: boolean;
  login: { required: true } | null;
  policy: { maxPricePerRender: string; dailyBudget: string };
  cap: { max: number; paidToday: number } | null;
  chainId: number;
  explorer: string | null;
  contracts: { creators: string; licences: string; receipts: string; settlement: string; token: string };
  token: string;
  rail: string;
  creator: string;
  payout: string;
  brand: string;
  terms: { pricePerRender: string; price: string; maxRenders: number; categories: number; autoApprove: boolean };
  spentToday: string;
  agentic: { source: "hashkey-qa" | "emulator"; network: string; chainId: number; token: { address: string; decimals: number; symbol: string; protocol: string }; recordable: boolean; merchantName: string } | null;
};

export type Licence = {
  id: string;
  creator: string;
  licensee: string;
  status: "Active" | "Revoked" | "Expired" | "Exhausted" | "Unknown";
  renderCount: number;
  renderCap: number;
  pricePerRender: string;
  end: number;
  tx: string;
};

export type Payment = {
  licenceId: string;
  renderIndex: number;
  payer: string;
  payout: string;
  amount: string;
  nonceBound: boolean;
  hspTx: string;
  recordTx: string;
  assetHash: string | null;
  anchorTx: string | null;
};

export type LogEvent = { seq: number; at: string; actor: string; kind: string; summary: string; data?: Record<string, unknown> & { tx?: string; payment?: { tx_signature?: string } } };

export type Approval = {
  id: string;
  stage: "sign" | "submit";
  payTo: string;
  payer: string;
  tokenTotalRaw: string;
  token: { address: string; decimals: number; symbol: string };
  gasFeeAdvanced?: boolean;
  quoteExpiresAt: string;
};

export type JobState = "paying" | "submitted" | "recorded" | "delivered" | "paid-not-recorded" | "refused" | "failed";
export type Job = {
  id: string;
  licenceId: string;
  state: JobState;
  renderIndex?: number;
  flowId?: string;
  paymentRequestId?: string;
  tokenTotalRaw?: string;
  hspTx?: string;
  nonceBound?: boolean;
  assetHash?: string;
  anchorTx?: string;
  note?: string;
  error?: string;
};
export type HspStatus = { at: string; summary: string; status: string; tx?: string; attribution?: boolean };
export type JobView = { job: Job; approvals: Approval[]; statuses: HspStatus[]; tx: string | null; attribution: boolean | null; toSeq: number };

export type Verdict = {
  verdict: "Licensed" | "Revoked" | "Expired" | "Unknown";
  reason?: string;
  licenceStatus?: string;
  licenceId?: string;
  renderIndex?: number;
  anchoredAt?: number;
  creator?: string;
  licensee?: string;
  paid?: string;
  hspTxHash?: string;
  nonceBound?: boolean;
  paidAt?: number;
  recordTx?: string | null;
  anchorTx?: string | null;
  licenceEnd?: number;
};

export async function api<T>(path: string, body?: unknown): Promise<T> {
  const res = await fetch(path, body === undefined ? { cache: "no-store" } : { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error((data as { error?: string }).error || `HTTP ${res.status}`);
  return data as T;
}

export const END_STATES: JobState[] = ["delivered", "paid-not-recorded", "refused", "failed"];
export const HSP_STATES = ["payment-submitted", "payment-verified", "payment-processing", "payment-included", "payment-safe", "payment-finalized"] as const;

/** "0.050000" from raw units and decimals. */
export function rawToDecimal(raw: string, decimals: number) {
  const v = BigInt(raw);
  const p = 10n ** BigInt(decimals);
  return `${v / p}.${(v % p).toString().padStart(decimals, "0")}`;
}

export const usd = (units: string | number) => (Number(units) / 1e6).toFixed(2);

export function gatewayLabel(g: Gateway) {
  return {
    hsp: "HSP Gateway: HashKey (live merchant credentials)",
    emulator: "HSP Gateway: local emulator",
    "hsp-agentic-qa": "HSP Agentic Payment: HashKey QA (MCP)",
    "hsp-agentic-emulator": "HSP Agentic Payment: offline emulator (MCP)",
  }[g];
}

/** sha256 of a file, as the 0x-hex the receipts are keyed by. Computed in the browser; nothing is uploaded. */
export async function sha256Hex(file: Blob) {
  const d = new Uint8Array(await crypto.subtle.digest("SHA-256", await file.arrayBuffer()));
  return `0x${[...d].map((b) => b.toString(16).padStart(2, "0")).join("")}`;
}

export function saveBlob(blob: Blob, name: string) {
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 5000);
}

/** The brand downloads its own render: the brand agent signs the claim, the server checks it like anyone's. */
export async function downloadAsBrand(assetHash: string, licenceId: string, renderIndex: number) {
  const claim = await api<{ issuedAt: string; signature: string }>("/api/brand/download", { assetHash });
  const res = await fetch(`/api/renders/${assetHash}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(claim) });
  if (!res.ok) throw new Error(((await res.json().catch(() => ({}))) as { error?: string }).error ?? `HTTP ${res.status}`);
  const blob = await res.blob();
  saveBlob(blob, `likeness-render-${licenceId}-${renderIndex}${blob.type === "image/svg+xml" ? ".svg" : ".png"}`);
}
