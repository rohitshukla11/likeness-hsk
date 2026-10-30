import { createPrivateKey, createPublicKey, generateKeyPairSync, randomBytes, type KeyObject } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { createPublicClient, http, parseAbi, parseAbiItem, type Address, type Hex, type LocalAccount, type PublicClient } from "viem";
import { BrandAgent, type CreatorConnection } from "../brand-agent/agent.js";
import { chainOf, licenseRegistryAbi, Likeness, type Deployment } from "../chain/contracts.js";
import { CreatorAgent } from "../creator-agent/agent.js";
import { startDevnet } from "../dev/devnet.js";
import { HspClient } from "../hsp/client.js";
import { loadHspConfig } from "../hsp/config.js";
import { deploymentsDir, rpcFor } from "../chain/networks.js";
import { HspGatewayEmulator } from "../hsp/emulator.js";
import { HspAgentic } from "../hsp/agentic/client.js";
import { chooseOption, type PaymentOption } from "../hsp/agentic/chainConfig.js";
import { HspAgenticEmulator } from "../hsp/agentic/emulator.js";
import { ApprovalDesk } from "./approvals.js";
import type { Approver } from "../hsp/agentic/payer.js";
import { keychainPassword, loadAccount } from "../keys.js";
import { MessageLog } from "../log.js";
import { geminiRenderer } from "../render/gemini.js";
import { RenderAgent, testRenderer, type Renderer } from "../render/renderAgent.js";
import { RenderStore } from "./store.js";

export type Mode = "local" | "testnet" | "mainnet";

export interface Runtime {
  mode: Mode;
  operator: boolean; // may this server act for the brand and the creator (license, pay, revoke)?
  gateway: "hsp" | "emulator" | "hsp-agentic-qa" | "hsp-agentic-emulator";
  /** HSP Agentic Payment (LIKENESS_HSP=agentic): the network and token from get_chain_config, and whether
   *  HspSettlement can record payments in that token (same chain and token as the deployment). */
  agentic?: { source: "hashkey-qa" | "emulator"; option: PaymentOption; recordable: boolean };
  /** The brand console's approvals before signing and before submitting (agentic). */
  approvals: ApprovalDesk;
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

// 0.05 USDT a render at most and 0.50 USDT a day: ten paid renders a day.
export const POLICY = { maxPricePerRender: 50_000n, allowedCategories: ADVERTISING, dailyBudget: 500_000n, maxRendersPerLicence: 5 };

/**
 * local: a devnet with throwaway keys (nothing leaves the machine).
 * testnet / mainnet: deployments/<network>.json and the encrypted keystores. The HSP Gateway is real
 * when .secrets/hsp/credentials.json exists; otherwise testnet uses the local emulator and mainnet
 * refuses to pay (the emulator never stands in for HSP on mainnet).
 */
export async function startRuntime(opts: { mode: Mode; root: string; publicUrl: string; operator: boolean; approve?: Approver }): Promise<Runtime> {
  const store = new RenderStore(`${opts.root}renders`);
  const r = pickRenderer();
  const approvals = new ApprovalDesk();
  // The brand console's approvals by default; the command-line run asks in the terminal instead.
  const approve = opts.approve ?? approvals.ask;
  const agenticMode = process.env.LIKENESS_HSP === "agentic";
  if (opts.mode === "local") {
    const n = await startDevnet({ rail: "permit2", publicUrl: opts.publicUrl, ...(agenticMode ? { hsp: "agentic" as const, approve } : {}) });
    let conn: CreatorConnection | undefined;
    return {
      mode: "local",
      operator: opts.operator,
      gateway: n.agentic ? "hsp-agentic-emulator" : "emulator",
      approvals,
      ...(n.agentic ? { agentic: { source: "emulator" as const, option: n.agentic.option, recordable: true } } : {}),
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
  let gateway: Runtime["gateway"];
  // HSP Agentic Payment: HashKey's QA MCP server once our egress IP is allowlisted, else the MCP emulator.
  let agentic: { creatorHsp: HspAgentic; brandHsp: HspAgentic; option: PaymentOption; source: "hashkey-qa" | "emulator"; balanceOf: (t: Address, who: Address) => Promise<bigint> } | undefined;
  if (agenticMode) {
    if (opts.mode === "mainnet") throw new Error("HSP Agentic Payment is HashKey's QA environment: not used on mainnet");
    const balanceOn = (p: PublicClient) => (t: Address, who: Address) => p.readContract({ address: t, abi: parseAbi(["function balanceOf(address) view returns (uint256)"]), functionName: "balanceOf", args: [who] });
    if (process.env.HSP_ALLOWLISTED === "1") {
      const [creatorHsp, brandHsp] = [await HspAgentic.connectQa(), await HspAgentic.connectQa()];
      const option = chooseOption(await creatorHsp.getChainConfig(), { chainId: process.env.HSP_CHAIN_ID ? Number(process.env.HSP_CHAIN_ID) : undefined, token: process.env.HSP_TOKEN });
      const net = option.chainId === d.chainId ? pub : option.chainId === 133 || option.chainId === 177 ? (createPublicClient({ transport: http(rpcFor(option.chainId === 133 ? "testnet" : "mainnet")) }) as PublicClient) : undefined;
      if (!net) throw new Error(`HSP pays on chain ${option.chainId}, which this app has no RPC for`);
      agentic = { creatorHsp, brandHsp, option, source: "hashkey-qa", balanceOf: balanceOn(net) };
    } else {
      const em = new HspAgenticEmulator({
        chain: chain.chain,
        rpcUrl: d.rpcUrl,
        publicClient: pub,
        executor: key(process.env.LIKENESS_EXECUTOR_KEY ?? "deployer"),
        network: d.hspNetwork,
        token: { address: d.token, decimals: 6, symbol: d.tokenSymbol, protocol: d.rail },
        permit2: d.permit2,
      });
      const c = await em.client();
      agentic = { creatorHsp: c, brandHsp: c, option: chooseOption(await c.getChainConfig()), source: "emulator", balanceOf: balanceOn(pub) };
    }
  }
  if (agentic) {
    gateway = agentic.source === "hashkey-qa" ? "hsp-agentic-qa" : "hsp-agentic-emulator";
    // The merchant REST API isn't used: HSP manages the app credentials behind its MCP server.
    hspBase = "http://127.0.0.1:9";
    creds = { appKey: "unused", appSecret: randomBytes(32).toString("hex") };
    merchantKey = generateKeyPairSync("ec", { namedCurve: "secp256k1" }).privateKey;
  } else if (hsp) {
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
    const executor = key(process.env.LIKENESS_EXECUTOR_KEY ?? "deployer");
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
    ...(agentic ? { agentic: { hsp: agentic.creatorHsp, option: agentic.option, pollMs: agentic.source === "hashkey-qa" ? 15_000 : 2000 } } : {}),
  });
  const brand = new BrandAgent({
    account: brandKey,
    chain,
    hsp: new HspClient({ baseUrl: hspBase, payMandatePath: hsp?.payMandatePath }),
    policy: POLICY,
    log,
    permit2Spender,
    jwtAudience: hsp?.jwtAudience,
    ...(agentic ? { agentic: { hsp: agentic.brandHsp, option: agentic.option, approve, balanceOf: agentic.balanceOf } } : {}),
  });
  let conn: CreatorConnection | undefined;
  return {
    mode: opts.mode,
    operator: opts.operator,
    gateway,
    approvals,
    ...(agentic
      ? { agentic: { source: agentic.source, option: agentic.option, recordable: agentic.option.chainId === d.chainId && agentic.option.token.address.toLowerCase() === d.token.toLowerCase() } }
      : {}),
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
    stop: () => {
      emulator?.stop();
      void agentic?.creatorHsp.close();
      if (agentic && agentic.brandHsp !== agentic.creatorHsp) void agentic.brandHsp.close();
    },
  };
}

const licenceIssued = parseAbiItem(
  "event LicenceIssued(uint256 indexed id, address indexed creator, address indexed licensee, uint32 category, uint32 regions, uint64 end, uint32 renderCap, uint128 pricePerRender, bytes32 purposeHash, bool autoApproved)",
);

/** HSK testnet's RPC answers eth_getLogs for ranges under ~5,000 blocks. */
const LOG_CHUNK = 4_000n;

/**
 * One event's logs since the deployment's start block: scanned once in chunks the RPC accepts, then only
 * the new blocks on each call. Callers filter in memory.
 */
class LogCache<T> {
  private readonly logs: T[] = [];
  private running?: Promise<T[]>;
  constructor(
    private readonly latest: () => Promise<bigint>,
    private readonly fetch: (fromBlock: bigint, toBlock: bigint) => Promise<T[]>,
    private next: bigint,
  ) {}

  all(): Promise<T[]> {
    return (this.running ??= this.catchUp().finally(() => (this.running = undefined)));
  }

  private async catchUp() {
    const latest = await this.latest();
    while (this.next <= latest) {
      const ranges: [bigint, bigint][] = [];
      for (let f = this.next; f <= latest && ranges.length < 6; f += LOG_CHUNK) ranges.push([f, f + LOG_CHUNK - 1n < latest ? f + LOG_CHUNK - 1n : latest]);
      for (const got of await Promise.all(ranges.map(([a, b]) => this.fetch(a, b)))) this.logs.push(...got);
      this.next = ranges.at(-1)![1] + 1n;
    }
    return this.logs;
  }
}

function logCaches(rt: Runtime) {
  const pub = rt.chain.public;
  const d = rt.chain.d;
  const latest = () => pub.getBlockNumber({ cacheTime: 0 });
  return {
    issued: new LogCache(latest, (fromBlock, toBlock) => pub.getLogs({ address: d.licences, event: licenceIssued, fromBlock, toBlock }), rt.startBlock),
    paid: new LogCache(latest, (fromBlock, toBlock) => pub.getLogs({ address: d.settlement, event: paymentRecorded, fromBlock, toBlock }), rt.startBlock),
    anchored: new LogCache(latest, (fromBlock, toBlock) => pub.getLogs({ address: d.settlement, event: renderAnchored, fromBlock, toBlock }), rt.startBlock),
  };
}
const cachesOf = new WeakMap<Runtime, ReturnType<typeof logCaches>>();
const logsOf = (rt: Runtime) => cachesOf.get(rt) ?? (cachesOf.set(rt, logCaches(rt)), cachesOf.get(rt)!);
const sameAddr = (a: string | undefined, b: string | undefined) => !b || (!!a && a.toLowerCase() === b.toLowerCase());

/** Licences by creator or licensee, with their current on-chain status. */
export async function listLicences(rt: Runtime, by: { creator?: Address; licensee?: Address }) {
  const logs = (await logsOf(rt).issued.all()).filter((l) => sameAddr(l.args.creator, by.creator) && sameAddr(l.args.licensee, by.licensee));
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
  const one = (a: { licenceId?: bigint; renderIndex?: number }) => filter.licenceId === undefined || (a.licenceId === filter.licenceId && (filter.renderIndex === undefined || a.renderIndex === filter.renderIndex));
  const [paid, anchored] = await Promise.all([logsOf(rt).paid.all(), logsOf(rt).anchored.all()]).then(([p, a]) => [p.filter((l) => one(l.args)), a.filter((l) => one(l.args))] as const);
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
