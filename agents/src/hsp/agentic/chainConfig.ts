/**
 * The payment configuration from get_chain_config (guide §5): the network, chain ID, token contract,
 * decimals and payment protocol all come from it, never from memory. If several network/token
 * combinations are offered and the choice isn't made, it stops and lists them so the user can choose.
 */
import type { Address } from "viem";

export interface PaymentOption {
  network: string;
  chainId: number;
  token: { address: Address; decimals: number; symbol: string; protocol: "eip3009" | "permit2" };
}

type Rec = Record<string, unknown>;
const isRec = (v: unknown): v is Rec => !!v && typeof v === "object" && !Array.isArray(v);

/** Every network/token pair in the answer, read only from the field names the guide gives. */
export function paymentOptions(cfg: unknown): PaymentOption[] {
  const networks: Rec[] = [];
  const visit = (v: unknown) => {
    if (Array.isArray(v)) v.forEach(visit);
    else if (isRec(v)) {
      if (Array.isArray(v.tokens) && (v.chain_id !== undefined || v.chainId !== undefined)) networks.push(v);
      else Object.values(v).forEach(visit);
    }
  };
  visit(cfg);
  if (!networks.length) throw new Error(`get_chain_config: no network with tokens found (top-level keys: ${isRec(cfg) ? Object.keys(cfg).join(", ") : typeof cfg}); read the live answer before choosing`);
  const out: PaymentOption[] = [];
  for (const n of networks) {
    const network = String(n.network ?? n.name ?? "");
    const chainId = Number(n.chain_id ?? n.chainId);
    for (const t of n.tokens as Rec[]) {
      const protocol = String(t.payment_protocol ?? "");
      if (protocol !== "eip3009" && protocol !== "permit2") continue;
      if (typeof t.address !== "string" || !/^0x[0-9a-fA-F]{40}$/.test(t.address) || t.decimals === undefined) continue;
      out.push({ network, chainId, token: { address: t.address as Address, decimals: Number(t.decimals), symbol: String(t.symbol ?? t.coin ?? t.name ?? "token"), protocol } });
    }
  }
  if (!out.length) throw new Error("get_chain_config: no token with an address, decimals and payment_protocol eip3009/permit2");
  return out;
}

/**
 * The one option to use: the only one offered, or the one matching the choice (chain ID and/or token
 * address). Otherwise stops with the list, for the user to choose.
 */
export function chooseOption(cfg: unknown, choice: { chainId?: number; token?: string } = {}): PaymentOption {
  const all = paymentOptions(cfg);
  const fits = all.filter((o) => (choice.chainId === undefined || o.chainId === choice.chainId) && (!choice.token || o.token.address.toLowerCase() === choice.token.toLowerCase()));
  if (fits.length === 1) return fits[0]!;
  const list = all.map((o) => `${o.network} (chain ${o.chainId}) ${o.token.symbol} ${o.token.address} ${o.token.protocol}, ${o.token.decimals} decimals`).join("; ");
  throw new Error(fits.length ? `get_chain_config offers several options; choose one (HSP_CHAIN_ID / HSP_TOKEN): ${list}` : `none of get_chain_config's options matches the choice: ${list}`);
}
