// Deploys the Likeness contracts to HSK Chain on the USDT / Permit2 rail and writes
// ../deployments/<network>.json (public addresses and transaction hashes only).
//
//   pnpm run deploy -- --network testnet              dry run: plan, balances, gas estimate
//   pnpm run deploy -- --network testnet --broadcast  deploy to chain 133 (with TestUSDT)
//   Mainnet also needs LIKENESS_MAINNET_DEPLOY=yes and is only run on Rohit's "deploy".
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { createPublicClient, createWalletClient, encodeDeployData, formatEther, http, type Abi, type Address, type Hex } from "viem";
import { chainOf, type Deployment } from "../src/chain/contracts.js";
import { deploymentsDir, NETWORKS, PERMIT2_ADDRESS, rpcFor, type NetworkName } from "../src/chain/networks.js";
import { keychainPassword, loadAccount } from "../src/keys.js";

const args = process.argv.slice(2);
const network = (args[args.indexOf("--network") + 1] ?? "") as NetworkName;
const broadcast = args.includes("--broadcast");
if (!(network in NETWORKS)) throw new Error("--network testnet|mainnet");
if (network === "mainnet" && broadcast && process.env.LIKENESS_MAINNET_DEPLOY !== "yes") {
  throw new Error("mainnet broadcast refused: needs LIKENESS_MAINNET_DEPLOY=yes (only on Rohit's \"deploy\")");
}
const net = { ...NETWORKS[network], rpcUrl: rpcFor(network) };
const root = fileURLToPath(new URL("../../", import.meta.url));
const artifact = (name: string, dir = `${name}.sol`) => {
  const j = JSON.parse(readFileSync(`${root}contracts/out/${dir}/${name}.json`, "utf8"));
  return { abi: j.abi as Abi, bytecode: j.bytecode.object as Hex };
};

const pw = keychainPassword();
const key = (n: string) => loadAccount(`${root}.secrets/keystores/${n}`, pw);
const deployer = key("deployer");
const attester = key("attester").address;
const renderAgent = key("render-agent").address;

const chain = chainOf({ chainId: net.chainId, rpcUrl: net.rpcUrl, explorer: net.explorer } as Deployment);
const pub = createPublicClient({ chain, transport: http(net.rpcUrl) });
const wallet = createWalletClient({ account: deployer, chain, transport: http(net.rpcUrl) });
if ((await pub.getChainId()) !== net.chainId) throw new Error("RPC is on the wrong chain");

const owner = deployer.address;
const ZERO = "0x0000000000000000000000000000000000000000" as Address;
const plan: { name: string; args: unknown[] }[] = [
  { name: "CreatorRegistry", args: [owner, attester] },
  { name: "LicenseRegistry", args: [owner, ZERO] }, // creators filled in below
  { name: "ReceiptAnchor", args: [owner] },
];

const gasPrice = await pub.getGasPrice();
const balance = await pub.getBalance({ address: owner });
console.log(`network ${network} (chain ${net.chainId}), deployer ${owner}, balance ${formatEther(balance)} HSK, gas price ${Number(gasPrice) / 1e9} gwei`);
console.log(`attester ${attester}, render agent ${renderAgent}, token ${network === "testnet" ? "TestUSDT (deployed now)" : net.usdt}, Permit2 ${PERMIT2_ADDRESS}`);

if (!broadcast) {
  let gas = 0n;
  for (const n of ["CreatorRegistry", "LicenseRegistry", "ReceiptAnchor", "HspSettlement", ...(network === "testnet" ? ["TestUSDT"] : [])]) {
    const a = n === "TestUSDT" ? artifact("TestUSDT", "TestUSDT.sol") : artifact(n);
    let g: bigint;
    if (n === "HspSettlement") {
      // Its constructor reads the LicenseRegistry, which doesn't exist in a dry run: estimate from size.
      const deployed = JSON.parse(readFileSync(`${root}contracts/out/HspSettlement.sol/HspSettlement.json`, "utf8")).deployedBytecode.object as string;
      g = 53_000n + 200n * BigInt((deployed.length - 2) / 2) + 16n * BigInt((a.bytecode.length - 2) / 2) + 150_000n;
    } else {
      const ctorArgs = n === "CreatorRegistry" ? [owner, attester] : n === "LicenseRegistry" ? [owner, owner] : [owner];
      g = await pub.estimateGas({ account: owner, data: encodeDeployData({ abi: a.abi, bytecode: a.bytecode, args: ctorArgs as never }) });
    }
    console.log(`  ${n.padEnd(16)} ≈ ${g} gas`);
    gas += g;
  }
  gas += 3n * 60_000n; // setSettlement ×2, setRenderAgent
  console.log(`total ≈ ${gas} gas ≈ ${formatEther(gas * gasPrice)} HSK at the current gas price (plus the L1 data fee). Dry run: nothing sent.`);
  process.exit(0);
}

const txs: Record<string, Hex> = {};
const deploy = async (label: string, name: string, ctorArgs: unknown[], dir?: string) => {
  const { abi, bytecode } = artifact(name, dir);
  const hash = await wallet.deployContract({ abi, bytecode, args: ctorArgs as never });
  const r = await pub.waitForTransactionReceipt({ hash });
  if (r.status !== "success" || !r.contractAddress) throw new Error(`${label} deploy failed: ${hash}`);
  txs[label] = hash;
  console.log(`${label.padEnd(16)} ${r.contractAddress}  ${net.explorer}/tx/${hash}`);
  return { address: r.contractAddress, block: r.blockNumber };
};
const call = async (label: string, address: Address, name: string, fn: string, fnArgs: unknown[]) => {
  const { abi } = artifact(name);
  const hash = await wallet.writeContract({ address, abi, functionName: fn, args: fnArgs as never });
  const r = await pub.waitForTransactionReceipt({ hash });
  if (r.status !== "success") throw new Error(`${label} failed: ${hash}`);
  txs[label] = hash;
  console.log(`${label.padEnd(16)} ${net.explorer}/tx/${hash}`);
};

const creators = await deploy("CreatorRegistry", "CreatorRegistry", plan[0]!.args);
const licences = await deploy("LicenseRegistry", "LicenseRegistry", [owner, creators.address]);
const receipts = await deploy("ReceiptAnchor", "ReceiptAnchor", [owner]);
let token: Address = net.usdt;
if (network === "testnet") token = (await deploy("TestUSDT", "TestUSDT", [owner], "TestUSDT.sol")).address;
const settlement = await deploy("HspSettlement", "HspSettlement", [owner, 1, token, PERMIT2_ADDRESS, licences.address, receipts.address]);
await call("setSettlement(L)", licences.address, "LicenseRegistry", "setSettlement", [settlement.address]);
await call("setSettlement(R)", receipts.address, "ReceiptAnchor", "setSettlement", [settlement.address]);
await call("setRenderAgent", settlement.address, "HspSettlement", "setRenderAgent", [renderAgent, true]);

const out = {
  network,
  chainId: net.chainId,
  rpcUrl: net.rpcUrl,
  explorer: net.explorer,
  hspNetwork: net.hspNetwork,
  deployedAt: new Date().toISOString(),
  startBlock: Number(creators.block),
  owner,
  attester,
  renderAgent,
  rail: "permit2",
  permit2: PERMIT2_ADDRESS,
  token,
  tokenSymbol: "USDT",
  testToken: network === "testnet",
  creators: creators.address,
  licences: licences.address,
  receipts: receipts.address,
  settlement: settlement.address,
  txs,
};
mkdirSync(deploymentsDir(root), { recursive: true });
writeFileSync(`${deploymentsDir(root)}/${network}.json`, `${JSON.stringify(out, null, 2)}\n`);
console.log(`wrote ${deploymentsDir(root)}/${network}.json`);
