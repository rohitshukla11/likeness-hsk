import { createPrivateKey, createPublicKey, generateKeyPairSync, randomBytes, type KeyObject } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { createPublicClient, http, parseAbiItem, type Address, type Hex, type LocalAccount, type PublicClient } from "viem";
import { BrandAgent, type CreatorConnection } from "../brand-agent/agent.js";
import { chainOf, licenseRegistryAbi, Likeness, type Deployment } from "../chain/contracts.js";
import { CreatorAgent } from "../creator-agent/agent.js";
import { startDevnet } from "../dev/devnet.js";
import { HspClient } from "../hsp/client.js";
import { loadHspConfig } from "../hsp/config.js";
import { deploymentsDir, rpcFor } from "../chain/networks.js";
import { HspGatewayEmulator } from "../hsp/emulator.js";
import { keychainPassword, loadAccount } from "../keys.js";
import { MessageLog } from "../log.js";
import { geminiRenderer } from "../render/gemini.js";
import { RenderAgent, testRenderer, type Renderer } from "../render/renderAgent.js";
import { RenderStore } from "./store.js";

export type Mode = "local" | "testnet" | "mainnet";

export interface Runtime {
  mode: Mode;
  operator: boolean; // may this server act for the brand and the creator (license, pay, revoke)?
  gateway: "hsp" | "emulator";
  renderer: "gemini" | "test";
  chain: Likeness;
  log: MessageLog;
  creatorAgent: CreatorAgent;
  brand: BrandAgent;
  render: RenderAgent;
  store: RenderStore;
  creator: Address;
  brandAddress: Address;
  startBlock: bigint;
  connect(): Promise<CreatorConnection>;
  brandAccount(): LocalAccount; // operator only
  revoke(licenceId: bigint): Promise<Hex>; // operator only, signs as the creator
  stop(): void;
}

export const ADVERTISING = 1 << 8;

/** Gemini only when a key is set (each render is a paid call); otherwise the marked TEST RENDER. */
function pickRenderer(): { name: "gemini" | "test"; renderer: Renderer } {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) return { name: "test", renderer: testRenderer };
  return {
    name: "gemini",
    renderer: geminiRenderer({
      apiKey,
      model: process.env.GEMINI_IMAGE_MODEL,
      creatorDescription: "Ana Reyes, a synthetic demo creator: warm smile, curly dark hair, olive skin, late twenties",
    }),
  };
}

const POLICY = { maxPricePerRender: 100_000n, allowedCategories: ADVERTISING, dailyBudget: 1_000_000n, maxRendersPerLicence: 5 };

/**
 * local: a devnet with throwaway keys (nothing leaves the machine).
 * testnet / mainnet: deployments/<network>.json and the encrypted keystores. The HSP Gateway is real
 * when .secrets/hsp/credentials.json exists; otherwise testnet uses the local emulator and mainnet
 * refuses to pay (the emulator never stands in for HSP on mainnet).
 */
export async function startRuntime(opts: { mode: Mode; root: string; publicUrl: string; operator: boolean }): Promise<Runtime> {
  const store = new RenderStore(`${opts.root}renders`);
  const r = pickRenderer();
  if (opts.mode === "local") {
    const n = await startDevnet({ rail: "permit2", publicUrl: opts.publicUrl });
    let conn: CreatorConnection | undefined;
    return {
      mode: "local",
      operator: opts.operator,
      gateway: "emulator",
      renderer: r.name,
      chain: n.chain,
      log: n.log,
      creatorAgent: n.creatorAgent,
      brand: n.brand,
      render: r.name === "test" ? n.render : new RenderAgent(n.accounts.renderAgent, n.chain, n.log, r.renderer),
      store,
      creator: n.accounts.creator.address,
      brandAddress: n.accounts.brand.address,
      startBlock: 0n,
      connect: async () => (conn ??= await n.connect()),
      brandAccount: () => n.accounts.brand,
      revoke: async (id) => {
        await n.revoke(id);
        return "0x" as Hex;
      },
      stop: n.stop,
    };
  }

  const dep = JSON.parse(readFileSync(`${deploymentsDir(opts.root)}/${opts.mode}.json`, "utf8"));
  const d: Deployment = {
    chainId: dep.chainId,
    rpcUrl: dep.rpcUrl,
    explorer: dep.explorer,
    hspNetwork: dep.hspNetwork,
    creators: dep.creators,
    licences: dep.licences,
    receipts: dep.receipts,
    settlement: dep.settlement,
    token: dep.token,
    tokenSymbol: dep.tokenSymbol,
    tokenDomain: { name: "", version: "", chainId: dep.chainId, verifyingContract: dep.token },
    rail: dep.rail,
    permit2: dep.permit2,
  };
  const pub = createPublicClient({ chain: chainOf(d), transport: http(d.rpcUrl), pollingInterval: 1000 }) as PublicClient;
  const chain = new Likeness(d, pub);
  const log = new MessageLog(`${deploymentsDir(opts.root)}/${opts.mode}-app.jsonl`);
  const pw = keychainPassword();
  const key = (name: string) => loadAccount(`${opts.root}.secrets/keystores/${name}`, pw);
  const [creator, creatorAgentKey, brandKey, renderKey] = ["creator", "creator-agent", "brand", "render-agent"].map(key) as [LocalAccount, LocalAccount, LocalAccount, LocalAccount];

  const merchantPem = `${opts.root}.secrets/hsp/merchant_private_key.pem`;
  const hsp = loadHspConfig(opts.root);
  let hspBase: string;
  let creds: { appKey: string; appSecret: string };
  let merchantKey: KeyObject;
  let emulator: HspGatewayEmulator | undefined;
  let permit2Spender: Address | undefined;
  let gateway: "hsp" | "emulator";
  if (hsp) {
    hspBase = hsp.baseUrl;
    creds = { appKey: hsp.appKey, appSecret: hsp.appSecret };
    merchantKey = hsp.merchantKey;
    permit2Spender = hsp.permit2Spender;
    gateway = "hsp";
  } else {
    // The emulator never stands in for HSP on mainnet; only a rehearsal on a local fork may use it.
    if (opts.mode === "mainnet" && !process.env.LIKENESS_RPC_URL) {
      throw new Error("mainnet needs real HSP credentials (.secrets/hsp/credentials.json); the emulator is never used on mainnet");
    }
    if (process.env.LIKENESS_RPC_URL) rpcFor("mainnet"); // throws unless it is a local fork
    const executor = key("deployer");
    emulator = new HspGatewayEmulator({ chain: chain.chain, rpcUrl: d.rpcUrl, publicClient: pub, executor, nonceMode: "payer" });
    emulator.permit2 = d.permit2;
    hspBase = await emulator.start();
    merchantKey = existsSync(merchantPem) ? createPrivateKey(readFileSync(merchantPem, "utf8")) : generateKeyPairSync("ec", { namedCurve: "secp256k1" }).privateKey;
    creds = { appKey: `ak_${randomBytes(6).toString("hex")}`, appSecret: randomBytes(32).toString("hex") };
    emulator.registerMerchant({ ...creds, merchantPublicKeyPem: createPublicKey(merchantKey).export({ type: "spki", format: "pem" }).toString(), webhookUrl: `${opts.publicUrl}/hsp/webhook` });
    permit2Spender = executor.address;
    gateway = "emulator";
  }

  const creatorAgent = new CreatorAgent({
    creator: creator.address,
    account: creatorAgentKey,
    chain,
    hsp: new HspClient({ baseUrl: hspBase, credentials: creds, payMandatePath: hsp?.payMandatePath }),
    webhookSecret: creds.appSecret,
    merchantKey,
    merchantName: hsp?.merchantName ?? "Ana Reyes (synthetic demo creator)",
    jwtAudience: hsp?.jwtAudience,
    recordAt: hsp?.recordAt,
    publicUrl: opts.publicUrl,
    log,
  });
  const brand = new BrandAgent({
    account: brandKey,
    chain,
    hsp: new HspClient({ baseUrl: hspBase, payMandatePath: hsp?.payMandatePath }),
    policy: POLICY,
    log,
    permit2Spender,
    jwtAudience: hsp?.jwtAudience,
  });
  let conn: CreatorConnection | undefined;
  return {
    mode: opts.mode,
    operator: opts.operator,
    gateway,
    renderer: r.name,
    chain,
    log,
    creatorAgent,
    brand,
    render: new RenderAgent(renderKey, chain, log, r.renderer),
    store,
    creator: creator.address,
    brandAddress: brandKey.address,
    startBlock: BigInt(dep.startBlock ?? 0),
    connect: async () => (conn ??= await brand.connect(opts.publicUrl)),
    brandAccount: () => brandKey,
    revoke: async (id) => {
      const r = await chain.write(creator, { address: d.licences, abi: licenseRegistryAbi, functionName: "revoke", args: [id] });
      log.add("chain", "tx", `creator revoked licence ${id}`, { tx: r.transactionHash });
      return r.transactionHash;
    },
    stop: () => emulator?.stop(),
  };
}

const licenceIssued = parseAbiItem(
  "event LicenceIssued(uint256 indexed id, address indexed creator, address indexed licensee, uint32 category, uint32 regions, uint64 end, uint32 renderCap, uint128 pricePerRender, bytes32 purposeHash, bool autoApproved)",
);

/** Licences by creator or licensee, with their current on-chain status. */
export async function listLicences(rt: Runtime, by: { creator?: Address; licensee?: Address }) {
  const logs = await rt.chain.public.getLogs({
    address: rt.chain.d.licences,
    event: licenceIssued,
    args: { creator: by.creator, licensee: by.licensee },
    fromBlock: rt.startBlock,
    toBlock: "latest",
  });
  return Promise.all(
    logs.map(async (l) => {
      const id = l.args.id!;
      const [lic, status] = await Promise.all([rt.chain.licence(id), rt.chain.status(id)]);
      return {
        id: id.toString(),
        creator: lic.creator,
        licensee: lic.licensee,
        status,
        renderCount: lic.renderCount,
        renderCap: lic.renderCap,
        pricePerRender: lic.pricePerRender.toString(),
        end: Number(lic.end),
        tx: l.transactionHash,
      };
    }),
  );
}

const paymentRecorded = parseAbiItem(
  "event PaymentRecorded(uint256 indexed licenceId, uint32 indexed renderIndex, address indexed payer, address payout, uint128 amount, bytes32 nonce, bool nonceBound, bytes32 hspTxHash, bytes32 hspPaymentRef)",
);
const renderAnchored = parseAbiItem("event RenderAnchored(uint256 indexed licenceId, uint32 indexed renderIndex, bytes32 assetHash, address agent)");

/** Payments recorded on chain (optionally for one licence and render), with their receipts. */
export async function listPayments(rt: Runtime, filter: { licenceIds?: Set<string>; licenceId?: bigint; renderIndex?: number } = {}) {
  const base = { address: rt.chain.d.settlement, fromBlock: rt.startBlock, toBlock: "latest" as const };
  const args = filter.licenceId !== undefined ? { licenceId: filter.licenceId, renderIndex: filter.renderIndex } : undefined;
  const [paid, anchored] = await Promise.all([
    rt.chain.public.getLogs({ ...base, event: paymentRecorded, args }),
    rt.chain.public.getLogs({ ...base, event: renderAnchored, args }),
  ]);
  const receipts = new Map(anchored.map((a) => [`${a.args.licenceId}-${a.args.renderIndex}`, a]));
  return paid
    .filter((p) => !filter.licenceIds || filter.licenceIds.has(String(p.args.licenceId)))
    .map((p) => {
      const a = receipts.get(`${p.args.licenceId}-${p.args.renderIndex}`);
      return {
        licenceId: String(p.args.licenceId),
        renderIndex: p.args.renderIndex!,
        payer: p.args.payer!,
        payout: p.args.payout!,
        amount: String(p.args.amount),
        nonceBound: p.args.nonceBound!,
        hspTx: p.args.hspTxHash!,
        recordTx: p.transactionHash,
        assetHash: a?.args.assetHash ?? null,
        anchorTx: a?.transactionHash ?? null,
      };
    })
    .reverse();
}
