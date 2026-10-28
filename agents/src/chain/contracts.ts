import {
  createPublicClient,
  createWalletClient,
  defineChain,
  http,
  type Address,
  type Chain,
  type Hex,
  type LocalAccount,
  type PublicClient,
  type WalletClient,
} from "viem";
import { creatorRegistryAbi, hspSettlementAbi, licenseRegistryAbi, receiptAnchorAbi } from "./abis.js";
import type { TokenDomain } from "../hsp/payment.js";

/** Where everything lives on one chain. Mainnet values are filled in at deploy time. */
export interface Deployment {
  chainId: number;
  rpcUrl: string;
  explorer?: string;
  hspNetwork: string; // HSP's network name for the cart's method_data
  creators: Address;
  licences: Address;
  receipts: Address;
  settlement: Address;
  token: Address;
  tokenSymbol: string; // "USDC" / "USDT"
  tokenDomain: TokenDomain; // EIP-712 domain of the token (EIP-3009 rail)
  rail: "eip3009" | "permit2";
  permit2?: Address; // Permit2 (defaults to the canonical 0x0000…22D473…78BA3)
}

export function chainOf(d: Deployment): Chain {
  return defineChain({
    id: d.chainId,
    name: d.chainId === 177 ? "HashKey Chain" : d.chainId === 133 ? "HashKey Chain Testnet" : `chain ${d.chainId}`,
    nativeCurrency: { name: "HSK", symbol: "HSK", decimals: 18 },
    rpcUrls: { default: { http: [d.rpcUrl] } },
    blockExplorers: d.explorer ? { default: { name: "Blockscout", url: d.explorer } } : undefined,
  });
}

export const LicenceStatus = ["Unknown", "Active", "Revoked", "Expired", "Exhausted"] as const;
export type LicenceStatusName = (typeof LicenceStatus)[number];

/** Typed reads and writes over the four contracts. */
export class Likeness {
  readonly public: PublicClient;
  readonly chain: Chain;

  constructor(readonly d: Deployment, publicClient?: PublicClient) {
    this.chain = chainOf(d);
    this.public = publicClient ?? (createPublicClient({ chain: this.chain, transport: http(d.rpcUrl) }) as PublicClient);
  }

  wallet(account: LocalAccount): WalletClient {
    return createWalletClient({ account, chain: this.chain, transport: http(this.d.rpcUrl) });
  }

  licence(id: bigint) {
    return this.public.readContract({ address: this.d.licences, abi: licenseRegistryAbi, functionName: "licence", args: [id] });
  }

  async status(id: bigint): Promise<LicenceStatusName> {
    const s = await this.public.readContract({ address: this.d.licences, abi: licenseRegistryAbi, functionName: "status", args: [id] });
    return LicenceStatus[s] ?? "Unknown";
  }

  terms(creator: Address) {
    return this.public.readContract({ address: this.d.creators, abi: creatorRegistryAbi, functionName: "terms", args: [creator] });
  }

  payoutOf(creator: Address) {
    return this.public.readContract({ address: this.d.creators, abi: creatorRegistryAbi, functionName: "payoutOf", args: [creator] });
  }

  canLicense(creator: Address) {
    return this.public.readContract({ address: this.d.creators, abi: creatorRegistryAbi, functionName: "canLicense", args: [creator] });
  }

  paymentNonce(licenceId: bigint, renderIndex: number): Promise<Hex> {
    return this.public.readContract({
      address: this.d.settlement,
      abi: hspSettlementAbi,
      functionName: "paymentNonce",
      args: [licenceId, renderIndex],
    });
  }

  payment(licenceId: bigint, renderIndex: number) {
    return this.public.readContract({ address: this.d.settlement, abi: hspSettlementAbi, functionName: "payment", args: [licenceId, renderIndex] });
  }

  nonceRecorded(payer: Address, nonce: Hex) {
    return this.public.readContract({ address: this.d.settlement, abi: hspSettlementAbi, functionName: "nonceRecorded", args: [payer, nonce] });
  }

  agentOf(creator: Address) {
    return this.public.readContract({ address: this.d.settlement, abi: hspSettlementAbi, functionName: "agentOf", args: [creator] });
  }

  receiptOf(assetHash: Hex) {
    return this.public.readContract({ address: this.d.receipts, abi: receiptAnchorAbi, functionName: "receiptOf", args: [assetHash] });
  }

  renderDigest(licenceId: bigint, assetHash: Hex, renderIndex: number, deadline: bigint) {
    return this.public.readContract({
      address: this.d.settlement,
      abi: hspSettlementAbi,
      functionName: "renderDigest",
      args: [licenceId, assetHash, renderIndex, deadline],
    });
  }

  /** Sends and waits; throws on revert, with the decoded reason when viem can decode it. */
  async write(account: LocalAccount, req: { address: Address; abi: readonly unknown[]; functionName: string; args: readonly unknown[] }) {
    const { request } = await this.public.simulateContract({ ...req, account } as never);
    const hash = await this.wallet(account).writeContract(request as never);
    const receipt = await this.public.waitForTransactionReceipt({ hash });
    if (receipt.status !== "success") throw new Error(`transaction reverted: ${hash}`);
    // Read-after-write: don't let a lagging RPC node answer the next read from an older block.
    for (let i = 0; i < 20 && (await this.public.getBlockNumber({ cacheTime: 0 })) < receipt.blockNumber; i++) {
      await new Promise((r) => setTimeout(r, 250));
    }
    return receipt;
  }
}

export { creatorRegistryAbi, hspSettlementAbi, licenseRegistryAbi, receiptAnchorAbi };
