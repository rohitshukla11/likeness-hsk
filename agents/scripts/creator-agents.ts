// After a redeploy of HspSettlement (HSP's token), each creator onboarded on this server names the shared
// creator agent again on the new contract, with their own custodial wallet. Run on the public server, as the
// app's user (the keystores and the accounts database are there):
//
//   pnpm run creator-agents                 dry run: each registered creator, its agent now, its gas
//   pnpm run creator-agents -- --broadcast  sends setAgent(creator agent) for those that need it
//
// Testnet only. The VM's own creator (Ana Reyes) is handled from the Mac by `pnpm run vm setup`.
import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { createPublicClient, createWalletClient, formatEther, http, type Address } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { Accounts } from "../src/app/accounts.js";
import { chainOf, hspSettlementAbi, type Deployment } from "../src/chain/contracts.js";
import { deploymentsDir } from "../src/chain/networks.js";
import { decryptKeystore, keychainPassword, loadAccount } from "../src/keys.js";

const broadcast = process.argv.includes("--broadcast");
const root = fileURLToPath(new URL("../../", import.meta.url));
const dep = JSON.parse(readFileSync(`${deploymentsDir(root)}/testnet.json`, "utf8"));
if (dep.chainId !== 133) throw new Error("testnet (chain 133) only");
const chain = chainOf({ chainId: dep.chainId, rpcUrl: dep.rpcUrl, explorer: dep.explorer } as Deployment);
const pub = createPublicClient({ chain, transport: http(dep.rpcUrl) });
const pw = keychainPassword();
const agent = (process.env.CREATOR_AGENT as Address | undefined) ?? loadAccount(`${root}.secrets/keystores/creator-agent`, pw).address;
const db = `${root}accounts/testnet/accounts.sqlite`;
if (!existsSync(db)) throw new Error(`no accounts database at ${db}`);
const accounts = new Accounts(db);
const creators = accounts.registeredCreators();
console.log(`HspSettlement ${dep.settlement}; creator agent ${agent}; ${creators.length} registered creator(s)`);
for (const c of creators) {
  const address = c.address as Address;
  const now = (await pub.readContract({ address: dep.settlement, abi: hspSettlementAbi, functionName: "agentOf", args: [address] })) as Address;
  const gas = await pub.getBalance({ address });
  const line = `${c.name} ${address}: agent ${now}, ${formatEther(gas)} test HSK`;
  if (now.toLowerCase() === agent.toLowerCase()) {
    console.log(`${line}: already set`);
    continue;
  }
  if (!broadcast) {
    console.log(`${line}: setAgent(${agent}) (dry run)`);
    continue;
  }
  const key = `${root}.secrets/creators/testnet/${address.toLowerCase()}.json`;
  const wallet = createWalletClient({ account: privateKeyToAccount(decryptKeystore(readFileSync(key, "utf8"), pw)), chain, transport: http(dep.rpcUrl) });
  const hash = await wallet.writeContract({ address: dep.settlement, abi: hspSettlementAbi, functionName: "setAgent", args: [agent] });
  const r = await pub.waitForTransactionReceipt({ hash });
  if (r.status !== "success") throw new Error(`setAgent reverted for ${address}: ${dep.explorer}/tx/${hash}`);
  console.log(`${line}: setAgent ${dep.explorer}/tx/${hash}`);
}
accounts.close();
