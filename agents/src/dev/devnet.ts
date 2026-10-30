import { spawn, type ChildProcess } from "node:child_process";
import { generateKeyPairSync, randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import { createServer } from "node:net";
import { fileURLToPath } from "node:url";
import {
  createPublicClient,
  createWalletClient,
  http,
  parseAbi,
  stringToHex,
  type Abi,
  type Address,
  type Hex,
  type LocalAccount,
  type PublicClient,
} from "viem";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { listen, serveA2A } from "../a2a/server.js";
import { BrandAgent, type CreatorConnection } from "../brand-agent/agent.js";
import type { BrandPolicy } from "../brand-agent/policy.js";
import { chainOf, creatorRegistryAbi, hspSettlementAbi, licenseRegistryAbi, Likeness, receiptAnchorAbi, type Deployment } from "../chain/contracts.js";
import { forceApprove } from "../chain/erc20.js";
import { CreatorAgent } from "../creator-agent/agent.js";
import { HspClient } from "../hsp/client.js";
import { HspGatewayEmulator } from "../hsp/emulator.js";
import type { HspAgentic } from "../hsp/agentic/client.js";
import { chooseOption, type PaymentOption } from "../hsp/agentic/chainConfig.js";
import { HspAgenticEmulator } from "../hsp/agentic/emulator.js";
import type { Approver } from "../hsp/agentic/payer.js";
import { MessageLog } from "../log.js";
import { RenderAgent } from "../render/renderAgent.js";
import { foundryBin } from "./foundry.js";

export const ADVERTISING = 1 << 8;
export const SOCIAL = 1 << 9;
export const PRICE = 50_000n; // 0.05 USDC.e

const OUT = fileURLToPath(new URL("../../../contracts/out/", import.meta.url)); // agents/src/dev → contracts/out
const artifact = (name: string) => {
  const j = JSON.parse(readFileSync(`${OUT}${name}.sol/${name}.json`, "utf8"));
  return { abi: j.abi as Abi, bytecode: j.bytecode.object as Hex };
};

async function freePort(): Promise<number> {
  return new Promise((resolve) => {
    const s = createServer();
    s.listen(0, "127.0.0.1", () => {
      const a = s.address();
      s.close(() => resolve(typeof a === "object" && a ? a.port : 0));
    });
  });
}

export interface Devnet {
  log: MessageLog;
  chain: Likeness;
  emulator: HspGatewayEmulator;
  creatorAgent: CreatorAgent;
  creatorAgentUrl: string;
  brand: BrandAgent;
  render: RenderAgent;
  conn: CreatorConnection;
  accounts: Record<"deployer" | "attester" | "creator" | "creatorAgent" | "brand" | "renderAgent" | "executor", LocalAccount>;
  payout: Address;
  token: Address;
  balanceOf(who: Address): Promise<bigint>;
  connect(): Promise<CreatorConnection>;
  revoke(licenceId: bigint): Promise<void>;
  stop(): void;
  /** With `hsp: "agentic"`: the HSP Agentic Payment emulator (MCP) and the client the agents use. */
  agentic?: { emulator: HspAgenticEmulator; hsp: HspAgentic; option: PaymentOption };
}

export interface DevnetOptions {
  rail?: "eip3009" | "permit2";
  /** On the Permit2 rail, a token that behaves like classic Tether USDT (HashKey's testnet USDT). */
  classicUsdt?: boolean;
  nonceMode?: "payer" | "gateway";
  policy?: Partial<BrandPolicy>;
  /** Host the creator agent elsewhere (the app server) at this URL; the devnet then serves nothing. */
  publicUrl?: string;
  /** "agentic": HSP Agentic Payment over MCP (offline emulator); default: the HSP merchant REST API emulator. */
  hsp?: "rest" | "agentic";
  /** The user's approvals before signing and before submitting (agentic). Default: approve. */
  approve?: Approver;
  /** The emulator's quote lifetime in seconds (agentic). Default 300, as HSP. */
  quoteSeconds?: number;
}

/** A local chain with the real contracts, a mock stablecoin, the HSP Gateway emulator and the agents. */
export async function startDevnet(opts: DevnetOptions = {}): Promise<Devnet> {
  const rail = opts.rail ?? "eip3009";
  const port = await freePort();
  const rpcUrl = `http://127.0.0.1:${port}`;
  const anvil: ChildProcess = spawn(foundryBin("anvil"), ["--port", String(port), "--chain-id", "31337", "--silent"], { stdio: "ignore" });
  const chainId = 31337;
  const tmpChain = chainOf({ chainId, rpcUrl } as Deployment);
  // Local anvil mines instantly; poll receipts every 50 ms instead of viem's default 4 s.
  const pub = createPublicClient({ chain: tmpChain, transport: http(rpcUrl), pollingInterval: 50 }) as PublicClient;
  for (let i = 0; ; i++) {
    try {
      await pub.getChainId();
      break;
    } catch {
      if (i > 100) throw new Error("anvil did not start");
      await new Promise((r) => setTimeout(r, 100));
    }
  }

  const fresh = () => privateKeyToAccount(generatePrivateKey());
  const accounts = {
    deployer: fresh(),
    attester: fresh(),
    creator: fresh(),
    creatorAgent: fresh(),
    brand: fresh(),
    renderAgent: fresh(),
    executor: fresh(),
  };
  const payout = fresh().address;
  for (const a of Object.values(accounts)) {
    await pub.request({ method: "anvil_setBalance" as never, params: [a.address, "0x56BC75E2D63100000"] as never }); // 100 native
  }

  const wallet = (a: LocalAccount) => createWalletClient({ account: a, chain: tmpChain, transport: http(rpcUrl) });
  const deploy = async (name: string, args: unknown[]) => {
    const { abi, bytecode } = artifact(name);
    const hash = await wallet(accounts.deployer).deployContract({ abi, bytecode, args });
    const r = await pub.waitForTransactionReceipt({ hash });
    return r.contractAddress!;
  };
  const send = async (a: LocalAccount, address: Address, abi: Abi, functionName: string, args: unknown[]) => {
    const hash = await wallet(a).writeContract({ address, abi, functionName, args } as never);
    const r = await pub.waitForTransactionReceipt({ hash });
    if (r.status !== "success") throw new Error(`${functionName} reverted`);
  };

  const owner = accounts.deployer.address;
  const creators = await deploy("CreatorRegistry", [owner, accounts.attester.address]);
  const licences = await deploy("LicenseRegistry", [owner, creators]);
  const receipts = await deploy("ReceiptAnchor", [owner]);
  let token: Address;
  let permit2: Address | undefined;
  if (rail === "eip3009") {
    token = await deploy("MockUSDC3009", []);
  } else {
    token = await deploy(opts.classicUsdt ? "MockClassicUSDT" : "MockUSDT", []);
    permit2 = await deploy("MockPermit2", []);
  }
  const settlement = await deploy("HspSettlement", [owner, rail === "eip3009" ? 0 : 1, token, permit2 ?? "0x0000000000000000000000000000000000000000", licences, receipts]);
  await send(accounts.deployer, licences, licenseRegistryAbi as Abi, "setSettlement", [settlement]);
  await send(accounts.deployer, receipts, receiptAnchorAbi as Abi, "setSettlement", [settlement]);
  await send(accounts.deployer, settlement, hspSettlementAbi as Abi, "setRenderAgent", [accounts.renderAgent.address, true]);

  // The creator: attested (synthetic demo creator), terms published, agent named.
  const attestation = {
    referenceSetHash: `0x${randomBytes(32).toString("hex")}` as Hex,
    livenessSessionHash: `0x${randomBytes(32).toString("hex")}` as Hex,
    livenessProvider: stringToHex("synthetic-demo", { size: 32 }),
    ageProvider: stringToHex("synthetic-demo", { size: 32 }),
    verifiedAt: BigInt(Math.floor(Date.now() / 1000)),
    adult: true,
  };
  const deadline = BigInt(Math.floor(Date.now() / 1000) + 3600);
  const digest = await pub.readContract({ address: creators, abi: creatorRegistryAbi, functionName: "attestationDigest", args: [accounts.creator.address, attestation, 0n, deadline] });
  const attesterSig = await accounts.attester.sign!({ hash: digest });
  await send(accounts.creator, creators, creatorRegistryAbi as Abi, "register", [
    payout,
    attestation,
    deadline,
    attesterSig,
    { categories: ADVERTISING | SOCIAL, regions: 0xffff, maxDuration: 30n * 86400n, maxRenders: 10, pricePerRender: PRICE, autoApprove: true },
  ]);
  await send(accounts.creator, settlement, hspSettlementAbi as Abi, "setAgent", [accounts.creatorAgent.address]);

  // The brand holds the stablecoin (and, on the USDT rail, has made the one-time Permit2 approval).
  await send(accounts.deployer, token, parseAbi(["function mint(address,uint256)"]), "mint", [accounts.brand.address, 10_000_000n]);
  if (permit2) await forceApprove(pub, (a, req) => send(a, req.address, req.abi as Abi, req.functionName, [...req.args]), accounts.brand, token, permit2, 2n ** 256n - 1n);

  const d: Deployment = {
    chainId,
    rpcUrl,
    hspNetwork: "anvil",
    creators,
    licences,
    receipts,
    settlement,
    token,
    tokenSymbol: rail === "eip3009" ? "USDC" : "USDT",
    tokenDomain: { name: "Bridged USDC", version: "2", chainId, verifyingContract: token },
    rail,
    permit2,
  };
  const log = new MessageLog();
  const chain = new Likeness(d, pub);

  // The HSP Gateway (local emulator) and the creator's merchant account on it.
  const emulator = new HspGatewayEmulator({ chain: chain.chain, rpcUrl, publicClient: pub, executor: accounts.executor, nonceMode: opts.nonceMode ?? "payer", stepDelayMs: 20 });
  emulator.permit2 = permit2;
  const gatewayUrl = await emulator.start();
  const { privateKey: merchantKey, publicKey } = generateKeyPairSync("ec", { namedCurve: "secp256k1" });
  const creds = { appKey: `ak_${randomBytes(6).toString("hex")}`, appSecret: randomBytes(32).toString("hex") };
  const agentPort = opts.publicUrl ? 0 : await freePort();
  const creatorAgentUrl = opts.publicUrl ?? `http://127.0.0.1:${agentPort}`;
  emulator.registerMerchant({ ...creds, merchantPublicKeyPem: publicKey.export({ type: "spki", format: "pem" }).toString(), webhookUrl: `${creatorAgentUrl}/hsp/webhook` });

  // HSP Agentic Payment: the MCP emulator; the agents use the network and token from its get_chain_config.
  let agentic: Devnet["agentic"];
  if (opts.hsp === "agentic") {
    const em = new HspAgenticEmulator({
      chain: chain.chain,
      rpcUrl,
      publicClient: pub,
      executor: accounts.executor,
      network: d.hspNetwork,
      token: { address: token, decimals: 6, symbol: d.tokenSymbol, protocol: rail, name: d.tokenDomain.name, version: d.tokenDomain.version },
      permit2,
      quoteSeconds: opts.quoteSeconds,
      stepDelayMs: 20,
    });
    const hsp = await em.client();
    agentic = { emulator: em, hsp, option: chooseOption(await hsp.getChainConfig()) };
  }
  const option = agentic?.option;
  const balance = (t: Address, who: Address) => pub.readContract({ address: t, abi: parseAbi(["function balanceOf(address) view returns (uint256)"]), functionName: "balanceOf", args: [who] });

  const creatorAgent = new CreatorAgent({
    creator: accounts.creator.address,
    account: accounts.creatorAgent,
    chain,
    hsp: new HspClient({ baseUrl: gatewayUrl, credentials: creds }),
    webhookSecret: creds.appSecret,
    merchantKey,
    merchantName: "Ana Reyes (synthetic demo creator)",
    publicUrl: creatorAgentUrl,
    log,
    ...(agentic && option ? { agentic: { hsp: agentic.hsp, option, pollMs: 50 } } : {}),
  });
  const server = opts.publicUrl ? undefined : serveA2A(creatorAgent);
  if (server) await listen(server, agentPort);

  const brand = new BrandAgent({
    account: accounts.brand,
    chain,
    hsp: new HspClient({ baseUrl: gatewayUrl }),
    policy: { maxPricePerRender: 100_000n, allowedCategories: ADVERTISING, dailyBudget: 1_000_000n, maxRendersPerLicence: 5, ...opts.policy },
    log,
    permit2Spender: accounts.executor.address,
    ...(agentic && option ? { agentic: { hsp: agentic.hsp, option, approve: opts.approve ?? (async () => true), balanceOf: balance } } : {}),
  });
  // When the app hosts the agent, it connects once it is listening (Devnet.connect).
  const conn = server ? await brand.connect(creatorAgentUrl) : (undefined as unknown as CreatorConnection);
  const render = new RenderAgent(accounts.renderAgent, chain, log);

  return {
    log,
    chain,
    emulator,
    creatorAgent,
    creatorAgentUrl,
    brand,
    render,
    conn,
    connect: async () => brand.connect(creatorAgentUrl),
    accounts,
    payout,
    token,
    balanceOf: (who) => pub.readContract({ address: token, abi: parseAbi(["function balanceOf(address) view returns (uint256)"]), functionName: "balanceOf", args: [who] }),
    revoke: (id) => send(accounts.creator, licences, licenseRegistryAbi as Abi, "revoke", [id]),
    agentic,
    stop: () => {
      server?.close();
      emulator.stop();
      void agentic?.hsp.close();
      anvil.kill();
    },
  };
}
