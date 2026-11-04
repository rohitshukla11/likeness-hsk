/**
 * The chain's name as the UI shows it, from the backend's chain id: Ethereum Sepolia during the hackathon
 * (the organisers allow it), HSK Chain testnet before that, HSK Chain on mainnet.
 */
export function chainLabel(chainId: number | undefined): string {
  if (chainId === 11155111) return "Ethereum Sepolia (testnet)";
  if (chainId === 133) return "HSK Chain testnet";
  if (chainId === 177) return "HSK Chain";
  return "chain";
}

/** One line on why the contracts are on Sepolia (How it works). */
export const SEPOLIA_NOTE =
  "Built for HSK Chain; contracts on Ethereum Sepolia during the hackathon, per the organisers; the HSK testnet deployment is kept; HSK mainnet migration if selected.";

/** The payment token's symbol once the backend's state has loaded; a neutral placeholder until then. */
export const tokenOf = (state: { token?: string } | null | undefined): string => state?.token ?? "…";

/** The label next to a payment's status: which HSP runs it. */
export function hspLabel(gateway: string | undefined, chainId: number | undefined): string {
  if (gateway === "hsp-agentic-qa") return chainId === 11155111 ? "HSP: HashKey QA (Sepolia)" : "HSP: HashKey QA";
  if (gateway === "hsp-agentic-emulator" || gateway === "emulator") return "HSP: offline emulator";
  return "HSP";
}
