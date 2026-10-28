// One complete paid render, end to end, and a refused one after revocation, with explorer links.
//
//   pnpm run testnet                                    chain 133 (emulated Gateway unless credentials exist)
//   LIKENESS_MAINNET_RUN=yes pnpm run demo -- --network mainnet   chain 177, real HSP only (Rohit's "deploy")
//
// Steps: creator registered (synthetic demo creator, attested) and its agent named; the brand's tUSDT
// (testnet only) and a bounded Permit2 approval; licence → HSP payment (0.05 USDT) → recorded on chain
// → receipt → the creator revokes → the next payment is refused before anything is signed.
import { randomBytes } from "node:crypto";
import { createServer } from "node:http";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { parseAbi, stringToHex, type Abi, type Address } from "viem";
import { Refused } from "../src/brand-agent/agent.js";
import { creatorRegistryAbi, hspSettlementAbi } from "../src/chain/contracts.js";
import { forceApprove } from "../src/chain/erc20.js";
import { keychainPassword, loadAccount } from "../src/keys.js";
import { startRuntime, ADVERTISING } from "../src/app/runtime.js";
import { deploymentsDir } from "../src/chain/networks.js";
import { handle } from "../src/app/server.js";

const args = process.argv.slice(2);
const network = (args.includes("--network") ? args[args.indexOf("--network") + 1] : "testnet") as "testnet" | "mainnet";
if (network !== "testnet" && network !== "mainnet") throw new Error("--network testnet|mainnet");
if (network === "mainnet" && process.env.LIKENESS_MAINNET_RUN !== "yes") {
  throw new Error("mainnet run refused: needs LIKENESS_MAINNET_RUN=yes (only on Rohit's \"deploy\")");
}
const root = fileURLToPath(new URL("../../", import.meta.url));
const dep = JSON.parse(readFileSync(`${deploymentsDir(root)}/${network}.json`, "utf8"));
const SOCIAL = 1 << 9;
const PRICE = 50_000n; // 0.05 USDT

// The app server hosts the creator agent (A2A + webhook). For the real Gateway's webhook, PUBLIC_URL
// must be an HTTPS tunnel to this port; without one, the creator agent polls the Gateway instead.
const port = Number(process.env.PORT ?? 8787);
const publicUrl = process.env.PUBLIC_URL ?? `http://127.0.0.1:${port}`;
const rt = await startRuntime({ mode: network, root, publicUrl, operator: true });
const server = createServer((req, res) => void handle(rt, req, res));
await new Promise<void>((r) => server.listen(port, "127.0.0.1", () => r()));
const link = (tx: string) => `${dep.explorer}/tx/${tx}`;
console.log(`${network} (chain ${dep.chainId}), gateway: ${rt.gateway}, agent at ${publicUrl}`);

const pw = keychainPassword();
const key = (n: string) => loadAccount(`${root}.secrets/keystores/${n}`, pw);
const step = async (label: string, account: ReturnType<typeof key>, address: Address, abi: Abi, functionName: string, fnArgs: unknown[]) => {
  const r = await rt.chain.write(account, { address, abi, functionName, args: fnArgs });
  console.log(`${label.padEnd(28)} ${link(r.transactionHash)}`);
};

try {
  // 1. Setup, once per deployment.
  const creator = key("creator");
  const d = rt.chain.d;
  if (!(await rt.chain.public.readContract({ address: d.creators, abi: creatorRegistryAbi, functionName: "isRegistered", args: [creator.address] }))) {
    const attester = key("attester");
    const a = {
      referenceSetHash: `0x${randomBytes(32).toString("hex")}` as const,
      livenessSessionHash: `0x${randomBytes(32).toString("hex")}` as const,
      livenessProvider: stringToHex("synthetic-demo", { size: 32 }),
      ageProvider: stringToHex("synthetic-demo", { size: 32 }),
      verifiedAt: BigInt(Math.floor(Date.now() / 1000)),
      adult: true,
    };
    const deadline = BigInt(Math.floor(Date.now() / 1000) + 3600);
    const digest = await rt.chain.public.readContract({ address: d.creators, abi: creatorRegistryAbi, functionName: "attestationDigest", args: [creator.address, a, 0n, deadline] });
    await step("register creator", creator, d.creators, creatorRegistryAbi as Abi, "register", [
      creator.address,
      a,
      deadline,
      await attester.sign!({ hash: digest }),
      { categories: ADVERTISING | SOCIAL, regions: 0xffff, maxDuration: 30n * 86400n, maxRenders: 10, pricePerRender: PRICE, autoApprove: true },
    ]);
  }
  const creatorAgent = key("creator-agent").address;
  if ((await rt.chain.agentOf(creator.address)).toLowerCase() !== creatorAgent.toLowerCase()) {
    await step("setAgent", creator, d.settlement, hspSettlementAbi as Abi, "setAgent", [creatorAgent]);
  }
  const erc20 = parseAbi(["function balanceOf(address) view returns (uint256)", "function allowance(address,address) view returns (uint256)", "function mint(address,uint256)"]);
  const brand = rt.brandAccount();
  const balance = await rt.chain.public.readContract({ address: d.token, abi: erc20, functionName: "balanceOf", args: [brand.address] });
  if (balance < 2n * PRICE) {
    if (!dep.testToken) throw new Error(`the brand holds ${balance} USDT base units; fund it with at least 0.10 USDT first`);
    await step("mint tUSDT to brand", key("deployer"), d.token, erc20 as Abi, "mint", [brand.address, 1_500_000n]);
  }
  if ((await rt.chain.public.readContract({ address: d.token, abi: erc20, functionName: "allowance", args: [brand.address, d.permit2!] })) < 2n * PRICE) {
    // forceApprove: HashKey's testnet USDT is classic Tether (approve returns nothing, zero first).
    await forceApprove(rt.chain.public, (a, req) => step(`brand approves Permit2 (${req.args[1]})`, a, req.address, req.abi as Abi, req.functionName, [...req.args]), brand, d.token, d.permit2!, 1_500_000n); // bounded
  }

  // 2. One paid render.
  const fromSeq = rt.log.events.at(-1)?.seq ?? 0;
  const conn = await rt.connect();
  const id = await rt.brand.license(conn, { category: ADVERTISING, regions: 1, durationSeconds: 7n * 86400n, renderCap: 3, purpose: `${network} demo run` });
  console.log(`licence ${id} issued`);
  const paid = await rt.brand.payForRender(conn, id);
  console.log(`${"HSP payment (Permit2)".padEnd(28)} ${link(paid.txHash)}`);
  void rt.creatorAgent.pollPayment(paid.paymentRequestId).catch(() => undefined); // in case no webhook arrives
  const p = await rt.brand.waitRecorded(id, paid.renderIndex, { timeoutMs: 300_000, intervalMs: 2000 });
  console.log(`payment recorded: ${Number(p.amount) / 1e6} USDT, nonce ${p.nonceBound ? "bound to the render" : "from the Gateway"}`);
  const out = await rt.render.renderAndAnchor(id, paid.renderIndex, `${network} hero shot`);
  rt.store.save(out.assetHash, out.bytes, { mime: out.mime, licenceId: id.toString(), renderIndex: paid.renderIndex });
  console.log(`${"receipt anchored".padEnd(28)} ${link(out.tx)}  (sha256 ${out.assetHash})`);

  // 3. Consent: the creator revokes; the next payment is refused before anything is signed.
  console.log(`${"creator revokes licence".padEnd(28)} ${link(await rt.revoke(id))}`);
  try {
    await rt.brand.payForRender(conn, id);
    console.log("UNEXPECTED: paid after revocation");
    process.exitCode = 1;
  } catch (e) {
    console.log(`after revocation: ${e instanceof Refused ? "refused before paying" : "error"}: ${(e as Error).message}`);
  }
  for (const e of rt.log.since(fromSeq).filter((x) => x.kind === "tx" && (x.data as { tx?: string }).tx?.startsWith("0x"))) {
    console.log(`  log: ${e.summary}  ${link((e.data as { tx: string }).tx)}`);
  }
} finally {
  server.close();
  rt.stop();
}
