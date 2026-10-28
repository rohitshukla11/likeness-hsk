// Sends gas (HSK) from the deployer to the other Likeness wallets.
//
//   pnpm run fund -- --network testnet              dry run
//   pnpm run fund -- --network testnet --broadcast  send
//   Mainnet also needs LIKENESS_MAINNET_FUND=yes and is only run on Rohit's "fund".
import { createPublicClient, createWalletClient, formatEther, http, parseEther } from "viem";
import { fileURLToPath } from "node:url";
import { chainOf, type Deployment } from "../src/chain/contracts.js";
import { NETWORKS, type NetworkName } from "../src/chain/networks.js";
import { keychainPassword, loadAccount } from "../src/keys.js";

const args = process.argv.slice(2);
const network = (args[args.indexOf("--network") + 1] ?? "") as NetworkName;
const broadcast = args.includes("--broadcast");
if (!(network in NETWORKS)) throw new Error("--network testnet|mainnet");
if (network === "mainnet" && broadcast && process.env.LIKENESS_MAINNET_FUND !== "yes") {
  throw new Error("mainnet funding refused: needs LIKENESS_MAINNET_FUND=yes (only on Rohit's \"fund\")");
}
// Mainnet amounts from the funding table (gas at 500 gwei); testnet gas is about 1 gwei.
const AMOUNTS: Record<NetworkName, Record<string, string>> = {
  testnet: { creator: "0.006", "creator-agent": "0.006", brand: "0.006", "render-agent": "0.006" },
  mainnet: { creator: "1", "creator-agent": "1.5", brand: "1.5", "render-agent": "2" },
};

const net = NETWORKS[network];
const root = fileURLToPath(new URL("../../", import.meta.url));
const pw = keychainPassword();
const deployer = loadAccount(`${root}.secrets/keystores/deployer`, pw);
const chain = chainOf({ chainId: net.chainId, rpcUrl: net.rpcUrl, explorer: net.explorer } as Deployment);
const pub = createPublicClient({ chain, transport: http(net.rpcUrl) });
const wallet = createWalletClient({ account: deployer, chain, transport: http(net.rpcUrl) });
if ((await pub.getChainId()) !== net.chainId) throw new Error("RPC is on the wrong chain");

console.log(`${network}: deployer ${deployer.address} has ${formatEther(await pub.getBalance({ address: deployer.address }))} HSK`);
for (const [name, amount] of Object.entries(AMOUNTS[network])) {
  const to = loadAccount(`${root}.secrets/keystores/${name}`, pw).address;
  const has = await pub.getBalance({ address: to });
  const want = parseEther(amount);
  if (has >= want) {
    console.log(`${name.padEnd(14)} ${to} already has ${formatEther(has)} HSK`);
    continue;
  }
  if (!broadcast) {
    console.log(`${name.padEnd(14)} ${to} would get ${formatEther(want - has)} HSK (dry run)`);
    continue;
  }
  const hash = await wallet.sendTransaction({ to, value: want - has });
  const r = await pub.waitForTransactionReceipt({ hash });
  console.log(`${name.padEnd(14)} ${to} +${formatEther(want - has)} HSK ${r.status} ${net.explorer}/tx/${hash}`);
}
