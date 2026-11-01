// The public server's own TESTNET wallets (option A: nothing from .secrets/keystores goes to the VM).
//
//   pnpm run vm -- keys                 new keystores in .secrets/vm/ (creator, creator-agent, brand,
//                                       render-agent, executor), a new keystore password and the demo
//                                       password; prints addresses only; never overwrites
//   pnpm run vm -- setup                dry run of the on-chain setup, from this Mac
//   pnpm run vm -- setup --broadcast    the deployer sends each wallet ~0.006 test HSK and mints 1 test USDT
//                                       to the new brand; the new creator registers (the attester signs)
//                                       and names its agent on HspSettlement; the Safe (owner of the
//                                       contracts, deployer as its single owner) allows the VM's render agent
//   pnpm run vm -- attester             the VM's own attester key (.secrets/vm/keystores/attester) and a dry
//                                       run of CreatorRegistry.setAttester(it), executed by the Safe
//   pnpm run vm -- attester --broadcast  sends it (the deployer, the Safe's single owner, with a
//                                       pre-validated signature); then the VM attests creators it onboards
//   pnpm run vm -- topup [--broadcast]  the deployer mints 5 test USDT to the VM brand and sends 0.01 test HSK
//                                       to the VM executor (dry run without --broadcast); prints the brand's
//                                       Permit2 approval for Rohit to run
// Testnet (chain 133) only. The new brand's Permit2 approval is printed for Rohit to run.
import { randomBytes } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { concat, createPublicClient, createWalletClient, encodeFunctionData, formatEther, http, pad, parseAbi, parseEther, stringToHex, type Abi, type Address, type LocalAccount } from "viem";
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
    if (has >= want / 2n) console.log(`${n.padEnd(14)} already has ${formatEther(has)} HSK`);
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

  // 5. The VM's render agent may anchor receipts: HspSettlement.setRenderAgent, executed by the Safe that owns
  //    it. A single owner can use a "pre-validated" signature: r = owner, s = 0, v = 1.
  const renderAbi = parseAbi(["function isRenderAgent(address) view returns (bool)", "function setRenderAgent(address,bool)"]);
  const safeAbi = parseAbi(["function execTransaction(address to, uint256 value, bytes data, uint8 operation, uint256 safeTxGas, uint256 baseGas, uint256 gasPrice, address gasToken, address refundReceiver, bytes signatures) payable returns (bool)", "function getOwners() view returns (address[])"]);
  if (await pub.readContract({ address: dep.settlement, abi: renderAbi, functionName: "isRenderAgent", args: [vm["render-agent"].address] })) console.log("render agent already allowed");
  else {
    const owners = await pub.readContract({ address: dep.safe, abi: safeAbi, functionName: "getOwners" });
    if (!owners.some((o) => o.toLowerCase() === deployer.address.toLowerCase())) throw new Error("the deployer isn't an owner of the Safe");
    const data = encodeFunctionData({ abi: renderAbi, functionName: "setRenderAgent", args: [vm["render-agent"].address, true] });
    const prevalidated = concat([pad(deployer.address, { size: 32 }), pad("0x00", { size: 32 }), "0x01"]);
    const zero = "0x0000000000000000000000000000000000000000" as const;
    await send("Safe: setRenderAgent(VM render agent)", deployer, { address: dep.safe, abi: safeAbi as Abi, functionName: "execTransaction", args: [dep.settlement, 0n, data, 0, 0n, 0n, 0n, zero, zero, prevalidated] });
  }

  console.log(`\nFor Rohit to run (the new brand approves Permit2 for 1 test USDT; cast asks nothing, the password is read from the file):
cast send ${dep.token} "approve(address,uint256)" ${dep.permit2} 1000000 \\
  --keystore .secrets/vm/keystores/brand --password-file .secrets/vm/keystore-password --rpc-url ${dep.rpcUrl}`);
} else if (args[0] === "attester") {
  const broadcast = args.includes("--broadcast");
  const dep = JSON.parse(readFileSync(`${deploymentsDir(root)}/testnet.json`, "utf8"));
  if (dep.chainId !== 133) throw new Error("testnet (chain 133) only");
  const chain = chainOf({ chainId: dep.chainId, rpcUrl: dep.rpcUrl, explorer: dep.explorer } as Deployment);
  const pub = createPublicClient({ chain, transport: http(dep.rpcUrl) });
  const vmPw = readFileSync(`${dir}/keystore-password`, "utf8").trimEnd();
  const path = `${dir}/keystores/attester`;
  if (!existsSync(path)) writeSecret(path, encryptKeystore(generatePrivateKey(), vmPw));
  const attester = loadAccount(path, vmPw);
  const deployer = loadAccount(`${root}.secrets/keystores/deployer`, keychainPassword());
  const registryAbi = parseAbi(["function attester() view returns (address)", "function owner() view returns (address)", "function setAttester(address)"]);
  const safeAbi = parseAbi(["function execTransaction(address to, uint256 value, bytes data, uint8 operation, uint256 safeTxGas, uint256 baseGas, uint256 gasPrice, address gasToken, address refundReceiver, bytes signatures) payable returns (bool)", "function getOwners() view returns (address[])", "function getThreshold() view returns (uint256)"]);
  const [current, owner, owners, threshold] = await Promise.all([
    pub.readContract({ address: dep.creators, abi: registryAbi, functionName: "attester" }),
    pub.readContract({ address: dep.creators, abi: registryAbi, functionName: "owner" }),
    pub.readContract({ address: dep.safe, abi: safeAbi, functionName: "getOwners" }),
    pub.readContract({ address: dep.safe, abi: safeAbi, functionName: "getThreshold" }),
  ]);
  const data = encodeFunctionData({ abi: registryAbi, functionName: "setAttester", args: [attester.address] });
  console.log(`CreatorRegistry      ${dep.creators}
  owner              ${owner}${owner.toLowerCase() === dep.safe.toLowerCase() ? " (the Safe)" : " (NOT the Safe)"}
  current attester   ${current}
  new attester       ${attester.address} (VM only; .secrets/vm/keystores/attester)
Safe                 ${dep.safe}, threshold ${threshold}, owners ${owners.join(", ")}
  executor           deployer ${deployer.address}${owners.some((o) => o.toLowerCase() === deployer.address.toLowerCase()) ? " (an owner)" : " (NOT an owner)"}
  call               execTransaction(to ${dep.creators}, value 0, data setAttester(${attester.address}) = ${data}, operation 0, pre-validated signature)
  deployer balance   ${formatEther(await pub.getBalance({ address: deployer.address }))} test HSK`);
  if (current.toLowerCase() === attester.address.toLowerCase()) {
    console.log("already the attester: nothing to send");
  } else if (!broadcast) {
    const gas = await pub.estimateContractGas({ account: deployer, address: dep.safe, abi: safeAbi, functionName: "execTransaction", args: [dep.creators, 0n, data, 0, 0n, 0n, 0n, "0x0000000000000000000000000000000000000000", "0x0000000000000000000000000000000000000000", concat([pad(deployer.address, { size: 32 }), pad("0x00", { size: 32 }), "0x01"])] });
    console.log(`  estimated gas      ${gas} (about ${formatEther(gas * (await pub.getGasPrice()))} test HSK)\n(dry run: nothing sent; add --broadcast to send)`);
  } else {
    if (owner.toLowerCase() !== dep.safe.toLowerCase() || threshold !== 1n || !owners.some((o) => o.toLowerCase() === deployer.address.toLowerCase())) throw new Error("the Safe must own CreatorRegistry, with the deployer as its single signer");
    const zero = "0x0000000000000000000000000000000000000000" as const;
    const w = createWalletClient({ account: deployer, chain, transport: http(dep.rpcUrl) });
    const hash = await w.writeContract({ address: dep.safe, abi: safeAbi, functionName: "execTransaction", args: [dep.creators, 0n, data, 0, 0n, 0n, 0n, zero, zero, concat([pad(deployer.address, { size: 32 }), pad("0x00", { size: 32 }), "0x01"])] });
    const r = await pub.waitForTransactionReceipt({ hash });
    if (r.status !== "success") throw new Error(`setAttester reverted: ${dep.explorer}/tx/${hash}`);
    // A load-balanced RPC can answer from a node a block behind: read until it shows the change.
    let now = current;
    for (let i = 0; i < 20 && now.toLowerCase() !== attester.address.toLowerCase(); i++) {
      await new Promise((res) => setTimeout(res, 1000));
      now = await pub.readContract({ address: dep.creators, abi: registryAbi, functionName: "attester" });
    }
    console.log(`Safe: setAttester    ${dep.explorer}/tx/${hash}\n  attester now       ${now}`);
  }
} else if (args[0] === "topup") {
  const broadcast = args.includes("--broadcast");
  const dep = JSON.parse(readFileSync(`${deploymentsDir(root)}/testnet.json`, "utf8"));
  if (dep.chainId !== 133) throw new Error("testnet (chain 133) only");
  const chain = chainOf({ chainId: dep.chainId, rpcUrl: dep.rpcUrl, explorer: dep.explorer } as Deployment);
  const pub = createPublicClient({ chain, transport: http(dep.rpcUrl) });
  const vmPw = readFileSync(`${dir}/keystore-password`, "utf8").trimEnd();
  const brand = loadAccount(`${dir}/keystores/brand`, vmPw).address;
  const executor = loadAccount(`${dir}/keystores/executor`, vmPw).address;
  const deployer = loadAccount(`${root}.secrets/keystores/deployer`, keychainPassword());
  const erc = parseAbi(["function balanceOf(address) view returns (uint256)", "function allowance(address,address) view returns (uint256)", "function mint(address,uint256)"]);
  const usdt = (a: Address) => pub.readContract({ address: dep.token, abi: erc, functionName: "balanceOf", args: [a] });
  const MINT = 5_000_000n;
  const HSK = parseEther("0.01");
  const show = async () =>
    console.log(`VM brand     ${brand}: ${Number(await usdt(brand)) / 1e6} test USDT, Permit2 allowance ${Number(await pub.readContract({ address: dep.token, abi: erc, functionName: "allowance", args: [brand, dep.permit2] })) / 1e6}
VM executor  ${executor}: ${formatEther(await pub.getBalance({ address: executor }))} test HSK
deployer     ${deployer.address}: ${formatEther(await pub.getBalance({ address: deployer.address }))} test HSK`);
  await show();
  console.log(`\n1. TestUSDT ${dep.token}.mint(${brand}, ${MINT}) = 5 test USDT, from the deployer
2. ${formatEther(HSK)} test HSK from the deployer to ${executor}`);
  if (!broadcast) console.log("(dry run: nothing sent; add --broadcast to send)");
  else {
    const w = createWalletClient({ account: deployer, chain, transport: http(dep.rpcUrl) });
    const m = await w.writeContract({ address: dep.token, abi: erc, functionName: "mint", args: [brand, MINT] });
    if ((await pub.waitForTransactionReceipt({ hash: m })).status !== "success") throw new Error(`mint reverted: ${dep.explorer}/tx/${m}`);
    console.log(`mint         ${dep.explorer}/tx/${m}`);
    const t = await w.sendTransaction({ to: executor, value: HSK });
    if ((await pub.waitForTransactionReceipt({ hash: t })).status !== "success") throw new Error(`transfer failed: ${dep.explorer}/tx/${t}`);
    console.log(`HSK          ${dep.explorer}/tx/${t}\n`);
    await show();
  }
  console.log(`\nFor Rohit to run (the VM brand approves Permit2 for 5 test USDT; the password is read from the file):
cast send ${dep.token} "approve(address,uint256)" ${dep.permit2} 5000000 \\
  --keystore .secrets/vm/keystores/brand --password-file .secrets/vm/keystore-password --rpc-url ${dep.rpcUrl}`);
} else {
  throw new Error("pnpm run vm -- keys | setup [--broadcast] | attester [--broadcast] | topup [--broadcast]");
}
