// Makes a Safe (Safe{Wallet} v1.4.1, deployed on HSK Chain) the owner of the four Likeness contracts.
//
//   pnpm run safe -- --network testnet [--owners 0xA,0xB] [--threshold 1]             dry run
//   pnpm run safe -- --network testnet [--owners …] --broadcast                         create + transfer + accept
//   Mainnet also needs LIKENESS_MAINNET_DEPLOY=yes (part of Rohit's "deploy").
// The deployer must be one of the owners (it executes the acceptOwnership calls). For mainnet, add a
// wallet you control yourself with --owners so the deployer key alone is not the only way in.
import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import {
  concat,
  createPublicClient,
  createWalletClient,
  decodeEventLog,
  encodeFunctionData,
  http,
  pad,
  parseAbi,
  type Address,
  type Hex,
} from "viem";
import { chainOf, type Deployment } from "../src/chain/contracts.js";
import { deploymentsDir } from "../src/chain/networks.js";
import { keychainPassword, loadAccount } from "../src/keys.js";

const SAFE_PROXY_FACTORY: Address = "0x4e1DCf7AD4e460CfD30791CCC4F9c8a4f820ec67";
const SAFE_L2_SINGLETON: Address = "0x29fcB43b46531BcA003ddC8FCB67FFE91900C762";
const FALLBACK_HANDLER: Address = "0xfd0732Dc9E303f09fCEf3a7388Ad10A83459Ec99";
const ZERO: Address = "0x0000000000000000000000000000000000000000";

const safeAbi = parseAbi([
  "function setup(address[] _owners, uint256 _threshold, address to, bytes data, address fallbackHandler, address paymentToken, uint256 payment, address paymentReceiver)",
  "function execTransaction(address to, uint256 value, bytes data, uint8 operation, uint256 safeTxGas, uint256 baseGas, uint256 gasPrice, address gasToken, address refundReceiver, bytes signatures) payable returns (bool)",
  "function getOwners() view returns (address[])",
  "function getThreshold() view returns (uint256)",
]);
const factoryAbi = parseAbi([
  "function createProxyWithNonce(address _singleton, bytes initializer, uint256 saltNonce) returns (address proxy)",
  "event ProxyCreation(address indexed proxy, address singleton)",
]);
const ownableAbi = parseAbi([
  "function owner() view returns (address)",
  "function pendingOwner() view returns (address)",
  "function transferOwnership(address newOwner)",
  "function acceptOwnership()",
]);

const args = process.argv.slice(2);
const opt = (k: string) => (args.includes(`--${k}`) ? args[args.indexOf(`--${k}`) + 1] : undefined);
const network = opt("network") ?? "";
const broadcast = args.includes("--broadcast");
if (network !== "testnet" && network !== "mainnet") throw new Error("--network testnet|mainnet");
if (network === "mainnet" && broadcast && process.env.LIKENESS_MAINNET_DEPLOY !== "yes") {
  throw new Error("mainnet refused: needs LIKENESS_MAINNET_DEPLOY=yes (only on Rohit's \"deploy\")");
}

const root = fileURLToPath(new URL("../../", import.meta.url));
const depPath = `${deploymentsDir(root)}/${network}.json`;
const dep = JSON.parse(readFileSync(depPath, "utf8"));
const deployer = loadAccount(`${root}.secrets/keystores/deployer`, keychainPassword());
const owners = (opt("owners")?.split(",") ?? [deployer.address]).map((a) => a.trim() as Address);
if (!owners.some((o) => o.toLowerCase() === deployer.address.toLowerCase())) owners.unshift(deployer.address);
const threshold = BigInt(opt("threshold") ?? "1");
const chain = chainOf({ chainId: dep.chainId, rpcUrl: dep.rpcUrl, explorer: dep.explorer } as Deployment);
const pub = createPublicClient({ chain, transport: http(dep.rpcUrl) });
const wallet = createWalletClient({ account: deployer, chain, transport: http(dep.rpcUrl) });
const link = (tx: Hex) => `${dep.explorer}/tx/${tx}`;
const contracts: [string, Address][] = [
  ["CreatorRegistry", dep.creators],
  ["LicenseRegistry", dep.licences],
  ["ReceiptAnchor", dep.receipts],
  ["HspSettlement", dep.settlement],
];

console.log(`${network}: Safe owners ${owners.join(", ")}, threshold ${threshold}`);
for (const [name, addr] of contracts) {
  console.log(`  ${name.padEnd(16)} ${addr} owner ${await pub.readContract({ address: addr, abi: ownableAbi, functionName: "owner" })}`);
}
if (!broadcast) {
  console.log("dry run: would create the Safe, transferOwnership ×4 from the deployer, then acceptOwnership ×4 through the Safe (≈ 0.9M gas)");
  process.exit(0);
}
if (threshold !== 1n) throw new Error("this script executes as a single owner; use threshold 1 (add owners later in Safe{Wallet})");

const send = async (label: string, req: Parameters<typeof wallet.writeContract>[0]) => {
  const hash = await wallet.writeContract(req);
  const r = await pub.waitForTransactionReceipt({ hash });
  if (r.status !== "success") throw new Error(`${label} failed: ${hash}`);
  console.log(`${label.padEnd(30)} ${link(hash)}`);
  // A load-balanced RPC may answer the next simulation from an older block: wait for this one.
  for (let i = 0; i < 40 && (await pub.getBlockNumber({ cacheTime: 0 })) < r.blockNumber; i++) await new Promise((x) => setTimeout(x, 250));
  return r;
};

// 1. The Safe.
let safe: Address | undefined = dep.safe;
if (!safe) {
  const initializer = encodeFunctionData({ abi: safeAbi, functionName: "setup", args: [owners, threshold, ZERO, "0x", FALLBACK_HANDLER, ZERO, 0n, ZERO] });
  const r = await send("create Safe", {
    address: SAFE_PROXY_FACTORY,
    abi: factoryAbi,
    functionName: "createProxyWithNonce",
    args: [SAFE_L2_SINGLETON, initializer, BigInt(Date.now())],
  } as never);
  for (const l of r.logs) {
    try {
      const ev = decodeEventLog({ abi: factoryAbi, data: l.data, topics: l.topics });
      if (ev.eventName === "ProxyCreation") safe = ev.args.proxy;
    } catch {
      /* other events */
    }
  }
  if (!safe) throw new Error("no ProxyCreation event");
  writeFileSync(depPath, `${JSON.stringify({ ...dep, safe }, null, 2)}\n`);
}
console.log(`Safe ${safe} (${dep.explorer}/address/${safe})`);

// 2 and 3. Ownable2Step: the deployer offers ownership, the Safe accepts.
// A single owner calling execTransaction can use a "pre-validated" signature: r = owner, s = 0, v = 1.
const prevalidated = concat([pad(deployer.address, { size: 32 }), pad("0x00", { size: 32 }), "0x01"]);
for (const [name, addr] of contracts) {
  const owner = await pub.readContract({ address: addr, abi: ownableAbi, functionName: "owner" });
  if (owner.toLowerCase() === safe.toLowerCase()) {
    console.log(`${name} already owned by the Safe`);
    continue;
  }
  const pending = await pub.readContract({ address: addr, abi: ownableAbi, functionName: "pendingOwner" });
  if (pending.toLowerCase() !== safe.toLowerCase()) {
    await send(`${name}.transferOwnership`, { address: addr, abi: ownableAbi, functionName: "transferOwnership", args: [safe] } as never);
  }
  for (let i = 0; i < 40; i++) {
    const p = await pub.readContract({ address: addr, abi: ownableAbi, functionName: "pendingOwner" });
    if (p.toLowerCase() === safe.toLowerCase()) break;
    await new Promise((x) => setTimeout(x, 500));
  }
  const data = encodeFunctionData({ abi: ownableAbi, functionName: "acceptOwnership" });
  await send(`${name}.acceptOwnership (Safe)`, {
    address: safe,
    abi: safeAbi,
    functionName: "execTransaction",
    args: [addr, 0n, data, 0, 0n, 0n, 0n, ZERO, ZERO, prevalidated],
  } as never);
}
for (const [name, addr] of contracts) {
  console.log(`  ${name.padEnd(16)} owner ${await pub.readContract({ address: addr, abi: ownableAbi, functionName: "owner" })}`);
}
