/**
 * The agents backend (agents/src/app/server.ts), proxied by next.config.ts: types of what it returns and
 * small fetch helpers. Every call runs in the browser, with the Google sign-in's ID token when signed in
 * (and the admin session cookie, if any).
 */
import { idToken } from "./firebase";

export type Gateway = "hsp" | "emulator" | "hsp-agentic-qa" | "hsp-agentic-emulator";

export type State = {
  mode: "local" | "testnet" | "mainnet";
  gateway: Gateway;
  renderer: "gemini" | "test";
  operator: boolean;
  login: { required: true } | null;
  policy: { maxPricePerRender: string; dailyBudget: string };
  cap: { max: number; paidToday: number } | null;
  signIn?: { google: boolean };
  /** Whether Ana Reyes, the synthetic demo creator, is listed on this server. */
  demoCreator?: boolean;
  /** AI ads (Vertex AI) or TEST RENDER, with the per-day caps. */
  ads?: { ai: boolean; videoMultiplier: number; brandCaps: Caps; siteCaps: Caps; usedToday: Caps };
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

export type Role = "brand" | "creator";
export type AdKind = "image" | "video";
export type Caps = { image: number; video: number };

export type Me = {
  account: { uid: string; email: string; name: string; picture: string | null; role: Role | null } | null;
  creator?: {
    address: string;
    name: string;
    label: string | null;
    youtube: { channelId: string; title: string | null; thumbnail: string | null } | null;
    photo: string | null;
    consentAt: number | null;
    payout: string | null;
    registeredTx: string | null;
    agentTx: string | null;
  } | null;
  brand?: { image: { used: number; cap: number }; video: { used: number; cap: number } } | null;
};

/** A creator brands can license: Ana Reyes (synthetic) or a signed-in, YouTube-verified creator. */
export type CreatorView = {
  address: string;
  synthetic: boolean;
  name: string | null;
  label: string | null;
  photo: string | null;
  youtube: { channelId: string; title: string | null; thumbnail: string | null; verifiedAt: number | null } | null;
  agentCard: string;
  registeredTx: string | null;
  payout: string;
  terms: { pricePerRender: string; price: string; maxRenders: number; categories: number; autoApprove: boolean };
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
  kind?: AdKind;
  brief?: string | null;
};

/** One licence of a bundle (images or videos) with its on-chain counters. */
export type BundleSlot = { licenceId: string; status: Licence["status"]; used: number; cap: number; price: string; pricePerRender: string; end: number } | null;

/** A licence bundle: one request (one brief), one licence per media type on chain. */
export type BundleView = {
  id: string;
  legacy: boolean;
  creator: string;
  creatorName: string | null;
  brand: string | null;
  brief: string;
  wanted: { images: number; videos: number };
  image: BundleSlot;
  video: BundleSlot;
  partial: boolean;
  status: string;
  createdAt: number;
};

/** A delivered render (gallery card): the record, the licence's status now, and the parties. */
export type RenderView = {
  assetHash: string;
  licenceId: string;
  renderIndex: number;
  kind: AdKind;
  mime: string;
  size: number;
  prompt: string | null;
  promptSha256: string | null;
  model: string | null;
  note: string | null;
  uid: string;
  creator: string;
  bundleId: string | null;
  hspTx: string | null;
  anchorTx: string | null;
  createdAt: number;
  licenceStatus?: string;
  brand: string | null;
  creatorName: string | null;
  hasPoster: boolean;
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

export type JobState = "paying" | "submitted" | "recorded" | "generating" | "delivered" | "paid-not-recorded" | "refused" | "failed";
export type Job = {
  id: string;
  licenceId: string;
  kind?: AdKind;
  state: JobState;
  progress?: string;
  mime?: string;
  model?: string;
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
  promptSha256?: string;
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
  bundle?: { id: string; brief: string; brand: string | null; imageLicence: string | null; videoLicence: string | null; kind: AdKind } | null;
  render?: { kind: AdKind; prompt: string | null; promptSha256: string | null; model: string | null; createdAt: number } | null;
};

/** The Authorization header for the signed-in account, if any. */
export async function idTokenHeader(): Promise<Record<string, string>> {
  const token = await idToken().catch(() => undefined);
  return token ? { authorization: `Bearer ${token}` } : {};
}

export async function api<T>(path: string, body?: unknown): Promise<T> {
  const auth = await idTokenHeader();
  const res = await fetch(path, body === undefined ? { cache: "no-store", headers: auth } : { method: "POST", headers: { "content-type": "application/json", ...auth }, body: JSON.stringify(body) });
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

const EXT: Record<string, string> = { "image/svg+xml": ".svg", "image/jpeg": ".jpg", "image/png": ".png", "video/mp4": ".mp4" };

/** The brand's own render: the brand agent signs the claim, the server checks it like anyone's. */
export async function fetchRenderAsBrand(assetHash: string): Promise<Blob> {
  const claim = await api<{ issuedAt: string; signature: string }>("/api/brand/download", { assetHash });
  const res = await fetch(`/api/renders/${assetHash}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(claim) });
  if (!res.ok) throw new Error(((await res.json().catch(() => ({}))) as { error?: string }).error ?? `HTTP ${res.status}`);
  return res.blob();
}

export async function downloadAsBrand(assetHash: string, licenceId: string, renderIndex: number, blob?: Blob) {
  const b = blob ?? (await fetchRenderAsBrand(assetHash));
  saveBlob(b, `likeness-${licenceId}-${renderIndex}${EXT[b.type] ?? ""}`);
}

/** A render's file or poster, fetched with the sign-in token (renders have no public URL). */
export async function authedBlob(path: string): Promise<Blob> {
  const res = await fetch(path, { headers: await idTokenHeader() });
  if (!res.ok) throw new Error(((await res.json().catch(() => ({}))) as { error?: string }).error ?? `HTTP ${res.status}`);
  return res.blob();
}

export const fmtBytes = (n: number) => (n > 1 << 20 ? `${(n / (1 << 20)).toFixed(1)} MB` : `${Math.max(1, Math.round(n / 1024))} KB`);
