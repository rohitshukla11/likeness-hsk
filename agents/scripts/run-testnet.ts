// HSK Chain TESTNET (133) end to end: the real contracts from deployments/testnet.json, TestUSDT on the
// Permit2 rail, our agents, and the local HSP Gateway emulator (HSP's QA gateway is not reachable yet).
// Prints explorer links for every transaction. Testnet only.
//
//   pnpm run testnet
import { generateKeyPairSync, randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { createPublicClient, http, parseAbi, stringToHex, type Abi, type Address, type PublicClient } from "viem";
import { listen, serveA2A } from "../src/a2a/server.js";
import { BrandAgent, Refused } from "../src/brand-agent/agent.js";
import { chainOf, creatorRegistryAbi, hspSettlementAbi, licenseRegistryAbi, Likeness, type Deployment } from "../src/chain/contracts.js";
import { CreatorAgent } from "../src/creator-agent/agent.js";
import { HspClient } from "../src/hsp/client.js";
import { HspGatewayEmulator } from "../src/hsp/emulator.js";
import { keychainPassword, loadAccount } from "../src/keys.js";
import { MessageLog } from "../src/log.js";
import { RenderAgent } from "../src/render/renderAgent.js";

const root = fileURLToPath(new URL("../../", import.meta.url));
const dep = JSON.parse(readFileSync(`${root}deployments/testnet.json`, "utf8"));
if (dep.chainId !== 133 || !dep.testToken) throw new Error("testnet only");
const ADVERTISING = 1 << 8;
const SOCIAL = 1 << 9;
const PRICE = 50_000n; // 0.05 tUSDT

const pw = keychainPassword();
const key = (n: string) => loadAccount(`${root}.secrets/keystores/${n}`, pw);
const [deployer, attester, creator, creatorAgentKey, brandKey, renderKey] = ["deployer", "attester", "creator", "creator-agent", "brand", "render-agent"].map(key);

const d: Deployment = {
  chainId: 133,
  rpcUrl: dep.rpcUrl,
  explorer: dep.explorer,
  hspNetwork: dep.hspNetwork,
  creators: dep.creators,
  licences: dep.licences,
  receipts: dep.receipts,
  settlement: dep.settlement,
  token: dep.token,
  tokenSymbol: "USDT",
  tokenDomain: { name: "", version: "", chainId: 133, verifyingContract: dep.token },
  rail: "permit2",
  permit2: dep.permit2,
};
const pub = createPublicClient({ chain: chainOf(d), transport: http(d.rpcUrl), pollingInterval: 1000 }) as PublicClient;
const chain = new Likeness(d, pub);
const log = new MessageLog(`${root}deployments/testnet-run.jsonl`);
const link = (tx: string) => `${d.explorer}/tx/${tx}`;
const step = async (label: string, account: typeof deployer, address: Address, abi: Abi, functionName: string, args: unknown[]) => {
  const r = await chain.write(account!, { address, abi, functionName, args });
  console.log(`${label.padEnd(26)} ${link(r.transactionHash)}`);
};

// 1. One-time setup: the creator (synthetic demo, attested), its agent, the brand's tUSDT and Permit2 approval.
if (!(await pub.readContract({ address: d.creators, abi: creatorRegistryAbi, functionName: "isRegistered", args: [creator!.address] }))) {
  const a = {
    referenceSetHash: `0x${randomBytes(32).toString("hex")}` as const,
    livenessSessionHash: `0x${randomBytes(32).toString("hex")}` as const,
    livenessProvider: stringToHex("synthetic-demo", { size: 32 }),
    ageProvider: stringToHex("synthetic-demo", { size: 32 }),
    verifiedAt: BigInt(Math.floor(Date.now() / 1000)),
    adult: true,
  };
  const deadline = BigInt(Math.floor(Date.now() / 1000) + 3600);
  const digest = await pub.readContract({ address: d.creators, abi: creatorRegistryAbi, functionName: "attestationDigest", args: [creator!.address, a, 0n, deadline] });
  const sig = await attester!.sign!({ hash: digest });
  await step("register creator", creator, d.creators, creatorRegistryAbi as Abi, "register", [
    creator!.address,
    a,
    deadline,
    sig,
    { categories: ADVERTISING | SOCIAL, regions: 0xffff, maxDuration: 30n * 86400n, maxRenders: 10, pricePerRender: PRICE, autoApprove: true },
  ]);
}
if ((await chain.agentOf(creator!.address)).toLowerCase() !== creatorAgentKey!.address.toLowerCase()) {
  await step("setAgent", creator, d.settlement, hspSettlementAbi as Abi, "setAgent", [creatorAgentKey!.address]);
}
const erc20 = parseAbi(["function balanceOf(address) view returns (uint256)", "function allowance(address,address) view returns (uint256)", "function approve(address,uint256) returns (bool)", "function mint(address,uint256)"]);
if ((await pub.readContract({ address: d.token, abi: erc20, functionName: "balanceOf", args: [brandKey!.address] })) < 10n * PRICE) {
  await step("mint tUSDT to brand", deployer, d.token, erc20 as Abi, "mint", [brandKey!.address, 1_500_000n]);
}
if ((await pub.readContract({ address: d.token, abi: erc20, functionName: "allowance", args: [brandKey!.address, d.permit2!] })) < 10n * PRICE) {
  await step("brand approves Permit2", brandKey, d.token, erc20 as Abi, "approve", [d.permit2!, 1_500_000n]); // bounded, not unlimited
}

// 2. The HSP Gateway emulator (executor = deployer, the Permit2 spender) and the creator's agent.
const emulator = new HspGatewayEmulator({ chain: chain.chain, rpcUrl: d.rpcUrl, publicClient: pub, executor: deployer!, nonceMode: "payer" });
emulator.permit2 = d.permit2;
const gatewayUrl = await emulator.start();
const { privateKey: merchantKey, publicKey } = generateKeyPairSync("ec", { namedCurve: "secp256k1" }); // throwaway, emulator only
const creds = { appKey: `ak_${randomBytes(6).toString("hex")}`, appSecret: randomBytes(32).toString("hex") };
const agentPort = 8787;
const agentUrl = `http://127.0.0.1:${agentPort}`;
emulator.registerMerchant({ ...creds, merchantPublicKeyPem: publicKey.export({ type: "spki", format: "pem" }).toString(), webhookUrl: `${agentUrl}/hsp/webhook` });
const creatorAgent = new CreatorAgent({
  creator: creator!.address,
  account: creatorAgentKey!,
  chain,
  hsp: new HspClient({ baseUrl: gatewayUrl, credentials: creds }),
  webhookSecret: creds.appSecret,
  merchantKey,
  merchantName: "Ana Reyes (synthetic demo creator)",
  publicUrl: agentUrl,
  log,
});
const server = serveA2A(creatorAgent);
await listen(server, agentPort);

// 3. The brand's payment agent: licence, pay one render through the Gateway, the render agent anchors.
const brand = new BrandAgent({
  account: brandKey!,
  chain,
  hsp: new HspClient({ baseUrl: gatewayUrl }),
  policy: { maxPricePerRender: 100_000n, allowedCategories: ADVERTISING, dailyBudget: 500_000n, maxRendersPerLicence: 5 },
  log,
  permit2Spender: deployer!.address,
});
try {
  const conn = await brand.connect(agentUrl);
  const id = await brand.license(conn, { category: ADVERTISING, regions: 1, durationSeconds: 7n * 86400n, renderCap: 3, purpose: "testnet run" });
  console.log(`licence ${id} issued`);
  const paid = await brand.payForRender(conn, id);
  console.log(`HSP payment (Permit2 transfer)  ${link(paid.txHash)}`);
  const p = await brand.waitRecorded(id, paid.renderIndex);
  console.log(`payment recorded: nonce ${p.nonceBound ? "bound to the render" : "from the gateway"}, ${p.amount} base units`);
  const out = await new RenderAgent(renderKey!, chain, log).renderAndAnchor(id, paid.renderIndex, "testnet hero shot");
  console.log(`receipt anchored                ${link(out.tx)}  (sha256 ${out.assetHash})`);

  // Consent: the creator revokes; the next render is refused before any money moves.
  await step("creator revokes licence", creator, d.licences, licenseRegistryAbi as Abi, "revoke", [id]);
  try {
    await brand.payForRender(conn, id);
    console.log("UNEXPECTED: paid after revocation");
  } catch (e) {
    console.log(`after revocation: ${e instanceof Refused ? "refused before paying" : "error"}: ${(e as Error).message}`);
  }
  for (const e of log.events.filter((x) => x.kind === "tx")) console.log(`  log: ${e.summary}  ${link((e.data as { tx: string }).tx)}`);
} finally {
  server.close();
  emulator.stop();
}
