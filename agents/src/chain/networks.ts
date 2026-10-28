import type { Address } from "viem";

/** Public facts about HSK Chain and HSP's tokens, checked on chain (see docs/HACKATHON.md). */
export const NETWORKS = {
  mainnet: {
    chainId: 177,
    rpcUrl: "https://mainnet.hsk.xyz",
    explorer: "https://hsk.blockscout.com",
    hspNetwork: "hashkey",
    // HSP's mainnet USDT (Permit2). USDC.e (EIP-3009) is 0x054ed45810DbBAb8B27668922D110669c9D88D0a.
    usdt: "0xF1B50eD67A9e2CC94Ad3c477779E2d4cBfFf9029" as Address,
  },
  testnet: {
    chainId: 133,
    rpcUrl: "https://testnet.hsk.xyz",
    explorer: "https://testnet-explorer.hskchain.net",
    hspNetwork: "hashkey-testnet",
    // HSP's testnet USDT (Permit2) has no public faucet, so testnet runs use our TestUSDT.
    usdt: "0x372325443233fEbaC1F6998aC750276468c83CC6" as Address,
  },
} as const;

export const PERMIT2_ADDRESS: Address = "0x000000000022D473030F116dDEE9F6B43aC78BA3";
export type NetworkName = keyof typeof NETWORKS;

/**
 * Rehearsal of the mainnet runbook against a local fork (anvil --fork-url https://mainnet.hsk.xyz):
 * LIKENESS_RPC_URL must be a localhost URL, and deployments go to LIKENESS_DEPLOYMENTS, so a rehearsal
 * can never reach the real network or write the real deployments/mainnet.json.
 */
export function rpcFor(network: NetworkName): string {
  const o = process.env.LIKENESS_RPC_URL;
  if (!o) return NETWORKS[network].rpcUrl;
  if (!/^http:\/\/(127\.0\.0\.1|localhost):\d+\/?$/.test(o)) throw new Error("LIKENESS_RPC_URL may only point at a local fork");
  if (!process.env.LIKENESS_DEPLOYMENTS) throw new Error("a rehearsal needs LIKENESS_DEPLOYMENTS (a separate folder)");
  return o;
}

export function deploymentsDir(root: string): string {
  return process.env.LIKENESS_DEPLOYMENTS ?? `${root}deployments`;
}
