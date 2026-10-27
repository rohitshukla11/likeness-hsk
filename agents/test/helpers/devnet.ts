import { spawn, type ChildProcess } from "node:child_process";
import { generateKeyPairSync, randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import { createServer } from "node:net";
import { homedir } from "node:os";
import { join } from "node:path";
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
import { listen, serveA2A } from "../../src/a2a/server.js";
import { BrandAgent, type CreatorConnection } from "../../src/brand-agent/agent.js";
import type { BrandPolicy } from "../../src/brand-agent/policy.js";
import { chainOf, creatorRegistryAbi, hspSettlementAbi, licenseRegistryAbi, Likeness, receiptAnchorAbi, type Deployment } from "../../src/chain/contracts.js";
import { CreatorAgent } from "../../src/creator-agent/agent.js";
import { HspClient } from "../../src/hsp/client.js";
import { HspGatewayEmulator } from "../../src/hsp/emulator.js";
import { MessageLog } from "../../src/log.js";
import { RenderAgent } from "../../src/render/renderAgent.js";

export const ADVERTISING = 1 << 8;
export const SOCIAL = 1 << 9;
export const PRICE = 50_000n; // 0.05 USDC.e

const OUT = fileURLToPath(new URL("../../../contracts/out/", import.meta.url));
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
  revoke(licenceId: bigint): Promise<void>;
  stop(): void;
}

export async function startDevnet(opts: { rail?: "eip3009" | "permit2"; nonceMode?: "payer" | "gateway"; policy?: Partial<BrandPolicy> } = {}): Promise<Devnet> {
  const rail = opts.rail ?? "eip3009";
  const port = await freePort();
  const rpcUrl = `http://127.0.0.1:${port}`;
  const anvil: ChildProcess = spawn(join(homedir(), ".foundry/bin/anvil"), ["--port", String(port), "--chain-id", "31337", "--silent"], { stdio: "ignore" });
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
    token = await deploy("MockUSDT", []);
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
  if (permit2) await send(accounts.brand, token, parseAbi(["function approve(address,uint256) returns (bool)"]), "approve", [permit2, 2n ** 256n - 1n]);

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
  const agentPort = await freePort();
  const creatorAgentUrl = `http://127.0.0.1:${agentPort}`;
  emulator.registerMerchant({ ...creds, merchantPublicKeyPem: publicKey.export({ type: "spki", format: "pem" }).toString(), webhookUrl: `${creatorAgentUrl}/hsp/webhook` });

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
  });
  const server = serveA2A(creatorAgent);
  await listen(server, agentPort);

  const brand = new BrandAgent({
    account: accounts.brand,
    chain,
    hsp: new HspClient({ baseUrl: gatewayUrl }),
    policy: { maxPricePerRender: 100_000n, allowedCategories: ADVERTISING, dailyBudget: 1_000_000n, maxRendersPerLicence: 5, ...opts.policy },
    log,
    permit2Spender: accounts.executor.address,
  });
  const conn = await brand.connect(creatorAgentUrl);
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
    accounts,
    payout,
    token,
    balanceOf: (who) => pub.readContract({ address: token, abi: parseAbi(["function balanceOf(address) view returns (uint256)"]), functionName: "balanceOf", args: [who] }),
    revoke: (id) => send(accounts.creator, licences, licenseRegistryAbi as Abi, "revoke", [id]),
    stop: () => {
      server.close();
      emulator.stop();
      anvil.kill();
    },
  };
}
