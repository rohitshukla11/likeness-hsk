/**
 * The payment configuration from get_chain_config (guide §5): the network, chain ID, token contract,
 * decimals and payment protocol all come from it, never from memory. If several network/token
 * combinations are offered and the choice isn't made, it stops and lists them so the user can choose.
 */
import type { Address } from "viem";

export interface PaymentOption {
  network: string;
  chainId: number;
  /**
   * name / version: the token's EIP-712 domain (EIP-3009 authorizations are signed against it), as the
   * live answer gives them; permit2Spender: the only spender a Permit2 authorization may name.
   */
  token: { address: Address; decimals: number; symbol: string; protocol: "eip3009" | "permit2"; name?: string; version?: string; permit2Spender?: Address };
}

type Rec = Record<string, unknown>;
const isRec = (v: unknown): v is Rec => !!v && typeof v === "object" && !Array.isArray(v);

const ADDRESS = /^0x[0-9a-fA-F]{40}$/;

function tokenOf(t: Rec): PaymentOption["token"] | undefined {
  const protocol = String(t.payment_protocol ?? "");
  if (protocol !== "eip3009" && protocol !== "permit2") return undefined;
  if (typeof t.address !== "string" || !ADDRESS.test(t.address) || t.decimals === undefined) return undefined;
  return {
    address: t.address as Address,
    decimals: Number(t.decimals),
    symbol: String(t.symbol ?? t.coin ?? t.name ?? "token"),
    protocol,
    ...(typeof t.name === "string" ? { name: t.name } : {}),
    ...(t.version !== undefined ? { version: String(t.version) } : {}),
    ...(typeof t.permit2_spender === "string" && ADDRESS.test(t.permit2_spender) ? { permit2Spender: t.permit2_spender as Address } : {}),
  };
}

/**
 * Every network/token pair in the answer, read only from the field names the guide gives. The live
 * answer lists networks[] and tokens[] separately, joined by chain_id; an answer with tokens nested in
 * each network is read too. Duplicates (the same token on the same chain) are listed once.
 */
export function paymentOptions(cfg: unknown): PaymentOption[] {
  const out: PaymentOption[] = [];
  const seen = new Set<string>();
  const add = (network: string, chainId: number, t: Rec) => {
    const token = tokenOf(t);
    const key = `${chainId}:${String(t.address).toLowerCase()}`;
    if (!token || seen.has(key)) return;
    seen.add(key);
    out.push({ network, chainId, token });
  };
  if (isRec(cfg) && Array.isArray(cfg.networks) && Array.isArray(cfg.tokens)) {
    const nets = (cfg.networks as unknown[]).filter(isRec);
    for (const t of (cfg.tokens as unknown[]).filter(isRec)) {
      const chainId = Number(t.chain_id ?? t.chainId);
      const n = nets.find((x) => Number(x.chain_id ?? x.chainId) === chainId);
      if (n) add(String(n.name ?? n.network ?? ""), chainId, t);
    }
  } else {
    const visit = (v: unknown) => {
      if (Array.isArray(v)) v.forEach(visit);
      else if (isRec(v)) {
        if (Array.isArray(v.tokens) && (v.chain_id !== undefined || v.chainId !== undefined)) {
          for (const t of (v.tokens as unknown[]).filter(isRec)) add(String(v.network ?? v.name ?? ""), Number(v.chain_id ?? v.chainId), t);
        } else Object.values(v).forEach(visit);
      }
    };
    visit(cfg);
  }
  if (!out.length) throw new Error(`get_chain_config: no token with an address, decimals and payment_protocol eip3009/permit2 (top-level keys: ${isRec(cfg) ? Object.keys(cfg).join(", ") : typeof cfg}); read the live answer before choosing`);
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
