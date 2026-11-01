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
import { RenderAgent, testRenderer, type Renderer, type RenderSubject } from "../render/renderAgent.js";
import type { AdGenerator } from "../ai/generate.js";
import { vertexGenerator } from "../ai/generate.js";
import { aiRenderer } from "../ai/renderer.js";
import { Accounts } from "./accounts.js";
import { firebaseVerifier, type VerifyIdToken } from "./firebase.js";
import { Onboarding } from "./onboarding.js";
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
  renderer: "vertex" | "gemini" | "test";
  /** AI ad generation (Vertex AI) and its brief check, when on (LIKENESS_AI=vertex). */
  ai?: AdGenerator;
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
  /** Google sign-in: accounts and roles, creator onboarding, and the Firebase ID token check. */
  accounts: Accounts;
  onboarding: Onboarding;
  verifyIdToken: VerifyIdToken;
  /** The creator agent acting for a creator: Ana Reyes's, or the shared agent at a registered creator's own endpoint. */
  agentFor(creator: Address): CreatorAgent | undefined;
  /** The brand agent's connection to a creator's agent (its A2A card). */
  connectTo(creator: Address): Promise<CreatorConnection>;
  /** Who a render is of: the creator's name and consented photo (registered creators). */
  subjectOf(creator: Address): RenderSubject | undefined;
  stop(): void;
}

/** Sign-in and onboarding settings, and AI generation; tests pass their own token check and generator. */
export interface AccountOptions {
  verifyIdToken?: VerifyIdToken;
  ai?: AdGenerator;
}

/** Accounts, onboarding and per-creator agents, the same for every mode. */
function accountsFor(o: {
  mode: Mode;
  root: string;
  publicUrl: string;
  chain: Likeness;
  log: MessageLog;
  creatorAgent: CreatorAgent;
  creator: Address;
  brand: BrandAgent;
  connectAna: () => Promise<CreatorConnection>;
  attester?: LocalAccount;
  funder: LocalAccount;
  agentAddress: Address;
  keystorePassword: string;
  verifyIdToken?: VerifyIdToken;
}) {
  const dir = `${o.root}accounts/${o.mode}`;
  // The local devnet is a fresh chain each run, so its accounts are too.
  const accounts = new Accounts(o.mode === "local" ? ":memory:" : `${dir}/accounts.sqlite`);
  const onboarding = new Onboarding({
    accounts,
    chain: o.chain,
    log: o.log,
    attester: o.attester,
    funder: o.funder,
    creatorAgent: o.agentAddress,
    templateCreator: o.creator,
    keysDir: `${o.root}.secrets/creators/${o.mode}`,
    photosDir: `${dir}/photos`,
    keystorePassword: o.keystorePassword,
    label: o.mode === "local" ? "local devnet" : process.env.LIKENESS_LOCAL_TEST === "1" ? "local test" : null,
  });
  const agents = new Map<string, CreatorAgent>();
  const conns = new Map<string, CreatorConnection>();
  const isAna = (c: Address) => c.toLowerCase() === o.creator.toLowerCase();
  const agentFor = (c: Address) => {
    if (isAna(c)) return o.creatorAgent;
    const row = accounts.creatorByAddress(c);
    if (!row?.registeredTx) return undefined;
    const k = c.toLowerCase();
    if (!agents.has(k)) agents.set(k, o.creatorAgent.forCreator(row.address as Address, `${o.publicUrl}/api/agents/${k}/a2a`, row.name));
    return agents.get(k);
  };
  return {
    accounts,
    onboarding,
    verifyIdToken: o.verifyIdToken ?? firebaseVerifier(process.env.FIREBASE_PROJECT_ID ?? "likeness-hsk"),
    agentFor,
    connectTo: async (c: Address) => {
      if (isAna(c)) return o.connectAna();
      if (!agentFor(c)) throw new Error(`${c} isn't a registered creator on this server`);
      const k = c.toLowerCase();
      if (!conns.has(k)) conns.set(k, await o.brand.connect(`${o.publicUrl}/api/agents/${k}`));
      return conns.get(k)!;
    },
    subjectOf: (c: Address): RenderSubject | undefined => {
      const row = accounts.creatorByAddress(c);
      if (!row) return undefined;
      const photo = onboarding.photo(row);
      return { name: row.name, ...(photo ? { photo } : {}) };
    },
  };
}

export const ADVERTISING = 1 << 8;

/**
 * AI image and video ads on Vertex AI when LIKENESS_AI=vertex (each render is a paid call; no API key:
 * the VM's service account or the likeness-hsk gcloud configuration); otherwise the marked TEST RENDER.
 */
function pickRenderer(ai?: AdGenerator): { name: "vertex" | "gemini" | "test"; renderer: Renderer; ai?: AdGenerator } {
  const gen = ai ?? (process.env.LIKENESS_AI === "vertex" ? vertexGenerator() : undefined);
  if (gen) return { name: "vertex", renderer: aiRenderer(gen), ai: gen };
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

/** A creator's price per render, at most (an image ad); a video licence costs VIDEO_MULTIPLIER renders. */
export const CREATOR_MAX_PRICE = 50_000n;
export const VIDEO_MULTIPLIER = 3n;
// At most 0.15 USDT a render (a video at 3x 0.05) and 1.00 USDT a day across brand accounts.
export const POLICY = { maxPricePerRender: CREATOR_MAX_PRICE * VIDEO_MULTIPLIER, allowedCategories: ADVERTISING, dailyBudget: 1_000_000n, maxRendersPerLicence: 5 };

/**
 * local: a devnet with throwaway keys (nothing leaves the machine).
 * testnet / mainnet: deployments/<network>.json and the encrypted keystores. The HSP Gateway is real
 * when .secrets/hsp/credentials.json exists; otherwise testnet uses the local emulator and mainnet
 * refuses to pay (the emulator never stands in for HSP on mainnet).
 */
export async function startRuntime(opts: { mode: Mode; root: string; publicUrl: string; operator: boolean; approve?: Approver } & AccountOptions): Promise<Runtime> {
  const store = new RenderStore(`${opts.root}renders`);
  const r = pickRenderer(opts.ai);
  const approvals = new ApprovalDesk();
  // The brand console's approvals by default; the command-line run asks in the terminal instead.
  const approve = opts.approve ?? approvals.ask;
  const agenticMode = process.env.LIKENESS_HSP === "agentic";
  if (opts.mode === "local") {
    // The same brand policy as on testnet, so local runs price and cap renders like the public server.
    const n = await startDevnet({ rail: "permit2", publicUrl: opts.publicUrl, policy: POLICY, ...(agenticMode ? { hsp: "agentic" as const, approve } : {}) });
    let conn: CreatorConnection | undefined;
    const connectAna = async () => (conn ??= await n.connect());
    return {
      ...accountsFor({
        mode: "local",
        root: opts.root,
        publicUrl: opts.publicUrl,
        chain: n.chain,
        log: n.log,
        creatorAgent: n.creatorAgent,
        creator: n.accounts.creator.address,
        brand: n.brand,
        connectAna,
        attester: n.accounts.attester,
        funder: n.accounts.deployer,
        agentAddress: n.accounts.creatorAgent.address,
        keystorePassword: randomBytes(24).toString("hex"),
        verifyIdToken: opts.verifyIdToken,
      }),
      mode: "local",
      operator: opts.operator,
      gateway: n.agentic ? "hsp-agentic-emulator" : "emulator",
      approvals,
      ...(n.agentic ? { agentic: { source: "emulator" as const, option: n.agentic.option, recordable: true } } : {}),
      renderer: r.name,
      ...(r.ai ? { ai: r.ai } : {}),
      chain: n.chain,
      log: n.log,
      creatorAgent: n.creatorAgent,
      brand: n.brand,
      render: r.name === "test" ? n.render : new RenderAgent(n.accounts.renderAgent, n.chain, n.log, r.renderer),
      store,
      creator: n.accounts.creator.address,
      brandAddress: n.accounts.brand.address,
      startBlock: 0n,
      connect: connectAna,
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
    // The token's EIP-712 domain (EIP-3009 authorizations), as get_chain_config gave it at deploy time.
    tokenDomain: { name: dep.tokenName ?? "", version: dep.tokenVersion ?? "", chainId: dep.chainId, verifyingContract: dep.token },
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
        token: { address: d.token, decimals: 6, symbol: d.tokenSymbol, protocol: d.rail, ...(dep.tokenName ? { name: dep.tokenName, version: dep.tokenVersion } : {}) },
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
  const connectAna = async () => (conn ??= await brand.connect(opts.publicUrl));
  // The platform's attester (signs creator attestations) and the wallet that funds new creators' gas.
  const attesterName = process.env.LIKENESS_ATTESTER_KEY ?? "attester";
  const attester = existsSync(`${opts.root}.secrets/keystores/${attesterName}`) ? key(attesterName) : undefined;
  return {
    ...accountsFor({
      mode: opts.mode,
      root: opts.root,
      publicUrl: opts.publicUrl,
      chain,
      log,
      creatorAgent,
      creator: creator.address,
      brand,
      connectAna,
      attester,
      funder: key(process.env.LIKENESS_FUNDER_KEY ?? process.env.LIKENESS_EXECUTOR_KEY ?? "deployer"),
      agentAddress: creatorAgentKey.address,
      keystorePassword: pw,
      verifyIdToken: opts.verifyIdToken,
    }),
    mode: opts.mode,
    operator: opts.operator,
    gateway,
    approvals,
    ...(agentic
      ? { agentic: { source: agentic.source, option: agentic.option, recordable: agentic.option.chainId === d.chainId && agentic.option.token.address.toLowerCase() === d.token.toLowerCase() } }
      : {}),
    renderer: r.name,
    ...(r.ai ? { ai: r.ai } : {}),
    chain,
    log,
    creatorAgent,
    brand,
    render: new RenderAgent(renderKey, chain, log, r.renderer),
    store,
    creator: creator.address,
    brandAddress: brandKey.address,
    startBlock: BigInt(dep.startBlock ?? 0),
    connect: connectAna,
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
