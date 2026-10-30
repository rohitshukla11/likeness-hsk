// The public server's own TESTNET wallets (option A: nothing from .secrets/keystores goes to the VM).
//
//   pnpm run vm -- keys                 new keystores in .secrets/vm/ (creator, creator-agent, brand,
//                                       render-agent, executor), a new keystore password and the demo
//                                       password; prints addresses only; never overwrites
//   pnpm run vm -- setup                dry run of the on-chain setup, from this Mac
//   pnpm run vm -- setup --broadcast    the deployer sends each wallet ~0.006 test HSK and mints 1 test USDT
//                                       to the new brand; the new creator registers (the attester signs)
//                                       and names its agent on HspSettlement
// Testnet (chain 133) only. The new brand's Permit2 approval is printed for Rohit to run.
import { randomBytes } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { createPublicClient, createWalletClient, formatEther, http, parseAbi, parseEther, stringToHex, type Abi, type Address, type LocalAccount } from "viem";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { chainOf, creatorRegistryAbi, hspSettlementAbi, type Deployment } from "../src/chain/contracts.js";
import { deploymentsDir } from "../src/chain/networks.js";
import { encryptKeystore, keychainPassword, loadAccount } from "../src/keys.js";
import { ADVERTISING } from "../src/app/runtime.js";

const args = process.argv.slice(2).filter((a) => a !== "--");
const root = fileURLToPath(new URL("../../", import.meta.url));
const dir = `${root}.secrets/vm`;
const NAMES = ["creator", "creator-agent", "brand", "render-agent", "executor"] as const;
const writeSecret = (path: string, data: string) => {
  writeFileSync(path, data, { mode: 0o600, flag: "wx" }); // wx: never overwrite
  chmodSync(path, 0o600);
};

if (args[0] === "keys") {
  mkdirSync(`${dir}/keystores`, { recursive: true, mode: 0o700 });
  if (!existsSync(`${dir}/keystore-password`)) writeSecret(`${dir}/keystore-password`, randomBytes(32).toString("base64url"));
  if (!existsSync(`${dir}/demo-password`)) writeSecret(`${dir}/demo-password`, randomBytes(12).toString("base64url"));
  const pw = readFileSync(`${dir}/keystore-password`, "utf8").trimEnd();
  for (const n of NAMES) {
    const path = `${dir}/keystores/${n}`;
    if (!existsSync(path)) writeSecret(path, encryptKeystore(generatePrivateKey(), pw));
    console.log(`${n.padEnd(14)} ${loadAccount(path, pw).address}`);
  }
  console.log(`keystores, keystore password and demo password in ${dir} (0600, gitignored)`);
} else if (args[0] === "setup") {
  const broadcast = args.includes("--broadcast");
  const dep = JSON.parse(readFileSync(`${deploymentsDir(root)}/testnet.json`, "utf8"));
  if (dep.chainId !== 133) throw new Error("testnet (chain 133) only");
  const chain = chainOf({ chainId: dep.chainId, rpcUrl: dep.rpcUrl, explorer: dep.explorer } as Deployment);
  const pub = createPublicClient({ chain, transport: http(dep.rpcUrl) });
  const link = (tx: string) => `${dep.explorer}/tx/${tx}`;
  const vmPw = readFileSync(`${dir}/keystore-password`, "utf8").trimEnd();
  const vm = Object.fromEntries(NAMES.map((n) => [n, loadAccount(`${dir}/keystores/${n}`, vmPw)])) as Record<(typeof NAMES)[number], LocalAccount>;
  const macPw = keychainPassword();
  const deployer = loadAccount(`${root}.secrets/keystores/deployer`, macPw);
  const send = async (label: string, account: LocalAccount, req: { address: Address; abi: Abi; functionName: string; args: unknown[] } | { to: Address; value: bigint }) => {
    if (!broadcast) return console.log(`${label.padEnd(30)} (dry run)`);
    const w = createWalletClient({ account, chain, transport: http(dep.rpcUrl) });
    const hash = "to" in req ? await w.sendTransaction(req) : await w.writeContract(req as Parameters<typeof w.writeContract>[0]);
    const r = await pub.waitForTransactionReceipt({ hash });
    if (r.status !== "success") throw new Error(`${label} reverted: ${link(hash)}`);
    console.log(`${label.padEnd(30)} ${link(hash)}`);
  };

  // 1. Gas for every VM wallet, from the deployer.
  for (const n of NAMES) {
    const has = await pub.getBalance({ address: vm[n].address });
    const want = parseEther("0.006");
    if (has >= want) console.log(`${n.padEnd(14)} already has ${formatEther(has)} HSK`);
    else await send(`${n}: +${formatEther(want - has)} HSK`, deployer, { to: vm[n].address, value: want - has });
  }
  // 2. Test USDT for the new brand (the deployment's TestUSDT; the deployer may mint).
  if (!dep.testToken) throw new Error("the deployment's token isn't our test token");
  const erc20 = parseAbi(["function balanceOf(address) view returns (uint256)", "function mint(address,uint256)"]);
  const usdt = await pub.readContract({ address: dep.token, abi: erc20, functionName: "balanceOf", args: [vm.brand.address] });
  if (usdt >= 500_000n) console.log(`brand already has ${usdt} USDT base units`);
  else await send("mint 1 test USDT to the brand", deployer, { address: dep.token, abi: erc20 as Abi, functionName: "mint", args: [vm.brand.address, 1_000_000n] });
  // 3. The new creator: registered with the attester's signature, terms 0.05 USDT a render.
  if (await pub.readContract({ address: dep.creators, abi: creatorRegistryAbi, functionName: "isRegistered", args: [vm.creator.address] })) console.log("creator already registered");
  else {
    const attester = loadAccount(`${root}.secrets/keystores/attester`, macPw);
    const a = {
      referenceSetHash: `0x${randomBytes(32).toString("hex")}` as const,
      livenessSessionHash: `0x${randomBytes(32).toString("hex")}` as const,
      livenessProvider: stringToHex("synthetic-demo", { size: 32 }),
      ageProvider: stringToHex("synthetic-demo", { size: 32 }),
      verifiedAt: BigInt(Math.floor(Date.now() / 1000)),
      adult: true,
    };
    const deadline = BigInt(Math.floor(Date.now() / 1000) + 3600);
    const digest = await pub.readContract({ address: dep.creators, abi: creatorRegistryAbi, functionName: "attestationDigest", args: [vm.creator.address, a, 0n, deadline] });
    await send("register the new creator", vm.creator, {
      address: dep.creators,
      abi: creatorRegistryAbi as Abi,
      functionName: "register",
      args: [vm.creator.address, a, deadline, await attester.sign!({ hash: digest }), { categories: ADVERTISING | (1 << 9), regions: 0xffff, maxDuration: 30n * 86400n, maxRenders: 10, pricePerRender: 50_000n, autoApprove: true }],
    });
  }
  // 4. The creator names its agent on HspSettlement.
  const agent = await pub.readContract({ address: dep.settlement, abi: hspSettlementAbi, functionName: "agentOf", args: [vm.creator.address] });
  if ((agent as string).toLowerCase() === vm["creator-agent"].address.toLowerCase()) console.log("creator agent already set");
  else await send("setAgent(creator-agent)", vm.creator, { address: dep.settlement, abi: hspSettlementAbi as Abi, functionName: "setAgent", args: [vm["creator-agent"].address] });

  console.log(`\nFor Rohit to run (the new brand approves Permit2 for 1 test USDT; cast asks nothing, the password is read from the file):
cast send ${dep.token} "approve(address,uint256)" ${dep.permit2} 1000000 \\
  --keystore .secrets/vm/keystores/brand --password-file .secrets/vm/keystore-password --rpc-url ${dep.rpcUrl}`);
} else {
  throw new Error("pnpm run vm -- keys | setup [--broadcast]");
}
