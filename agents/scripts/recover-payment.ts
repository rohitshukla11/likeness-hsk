// Records an HSP payment the creator agent missed (for example after a crash or an RPC hiccup), with
// exactly the same checks as the webhook path: the transfer to the payout in the transaction, the
// executed nonce, and the contract's own PaymentNotExecuted check.
//
//   pnpm run recover -- --network testnet --cart LIK-133-1-0-xxxxxxxx --request PR-… --tx 0x…
import { generateKeyPairSync } from "node:crypto";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { createPublicClient, http, type Hex, type PublicClient } from "viem";
import { chainOf, Likeness, type Deployment } from "../src/chain/contracts.js";
import { CreatorAgent } from "../src/creator-agent/agent.js";
import { HspClient } from "../src/hsp/client.js";
import { keychainPassword, loadAccount } from "../src/keys.js";
import { MessageLog } from "../src/log.js";

const args = process.argv.slice(2);
const arg = (k: string) => {
  const v = args[args.indexOf(`--${k}`) + 1];
  if (!v || args.indexOf(`--${k}`) < 0) throw new Error(`--${k} required`);
  return v;
};
const network = arg("network");
const root = fileURLToPath(new URL("../../", import.meta.url));
const dep = JSON.parse(readFileSync(`${root}deployments/${network}.json`, "utf8"));
const d: Deployment = { ...dep, tokenDomain: { name: "", version: "", chainId: dep.chainId, verifyingContract: dep.token } };
const pub = createPublicClient({ chain: chainOf(d), transport: http(d.rpcUrl), pollingInterval: 1000 }) as PublicClient;
const chain = new Likeness(d, pub);
const pw = keychainPassword();
const log = new MessageLog(`${root}deployments/${network}-recover.jsonl`);
const agent = new CreatorAgent({
  creator: loadAccount(`${root}.secrets/keystores/creator`, pw).address,
  account: loadAccount(`${root}.secrets/keystores/creator-agent`, pw),
  chain,
  hsp: new HspClient({ baseUrl: "http://unused" }), // settling reads the chain only
  webhookSecret: "unused",
  merchantKey: generateKeyPairSync("ec", { namedCurve: "secp256k1" }).privateKey,
  merchantName: "recovery",
  publicUrl: "http://unused",
  log,
});
const p = await agent.onPaymentUpdate({ cart_mandate_id: arg("cart"), payment_request_id: arg("request"), status: "payment-included", tx_signature: arg("tx") as Hex });
for (const e of log.events) console.log(`${e.actor} ${e.kind}: ${e.summary}${e.kind === "tx" ? ` ${d.explorer}/tx/${(e.data as { tx: string }).tx}` : ""}`);
console.log(p ? `recorded: payer ${(p as { payer: string }).payer}, nonce bound ${(p as { nonceBound: boolean }).nonceBound}` : "nothing to record");
