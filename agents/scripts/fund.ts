// Sends gas (HSK) from the deployer to the other Likeness wallets.
//
//   pnpm run fund -- --network testnet              dry run
//   pnpm run fund -- --network testnet --broadcast  send
//   pnpm run fund -- --network mainnet --swap-usdt 1.5   also swap HSK → USDT for the brand on HSKSwap
//     (QuoterV2 exact-output quote + 1% slippage, SwapRouter02 exactInputSingle, minimum out = the amount)
//   Mainnet also needs LIKENESS_MAINNET_FUND=yes and is only run on Rohit's "fund".
import { createPublicClient, createWalletClient, formatEther, http, parseAbi, parseEther, parseUnits } from "viem";
import { fileURLToPath } from "node:url";
import { chainOf, type Deployment } from "../src/chain/contracts.js";
import { NETWORKS, rpcFor, type NetworkName } from "../src/chain/networks.js";
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

const net = { ...NETWORKS[network], rpcUrl: rpcFor(network) };
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

// Optional: HSK → USDT for the brand (mainnet; testnet uses TestUSDT). HSKSwap WHSK/USDT 0.3% pool
// 0x4ff515761864e7838B0AdB8b5b2B8B7A068905dC; router and quoter checked to share its factory.
const swapArg = args.includes("--swap-usdt") ? args[args.indexOf("--swap-usdt") + 1] : undefined;
if (swapArg) {
  if (network !== "mainnet") throw new Error("--swap-usdt is for mainnet");
  const WHSK = "0xB210D2120d57b758EE163cFfb43e73728c471Cf1" as const;
  const USDT = NETWORKS.mainnet.usdt;
  const ROUTER = "0x2c16f75b95Cf1390c328aB70e2CEE7f4b80bD8F3" as const;
  const QUOTER = "0x1095A23A4812185344D9abd5143191D8a3A7E36f" as const;
  const out = parseUnits(swapArg, 6);
  const brand = loadAccount(`${root}.secrets/keystores/brand`, pw).address;
  const quoter = parseAbi(["function quoteExactOutputSingle((address tokenIn,address tokenOut,uint256 amount,uint24 fee,uint160 sqrtPriceLimitX96)) returns (uint256 amountIn,uint160,uint32,uint256)"]);
  const { result } = await pub.simulateContract({ address: QUOTER, abi: quoter, functionName: "quoteExactOutputSingle", args: [{ tokenIn: WHSK, tokenOut: USDT, amount: out, fee: 3000, sqrtPriceLimitX96: 0n }] });
  const amountIn = (result[0] * 101n) / 100n; // 1% slippage headroom
  console.log(`swap: ${formatEther(amountIn)} HSK → at least ${swapArg} USDT to the brand ${brand} (quote ${formatEther(result[0])} HSK)`);
  if (broadcast) {
    const router = parseAbi(["function exactInputSingle((address tokenIn,address tokenOut,uint24 fee,address recipient,uint256 amountIn,uint256 amountOutMinimum,uint160 sqrtPriceLimitX96)) payable returns (uint256)"]);
    const hash = await wallet.writeContract({
      address: ROUTER,
      abi: router,
      functionName: "exactInputSingle",
      args: [{ tokenIn: WHSK, tokenOut: USDT, fee: 3000, recipient: brand, amountIn, amountOutMinimum: out, sqrtPriceLimitX96: 0n }],
      value: amountIn,
    });
    const r = await pub.waitForTransactionReceipt({ hash });
    console.log(`swap ${r.status} ${net.explorer}/tx/${hash}`);
  } else {
    console.log("swap: dry run, nothing sent");
  }
}
