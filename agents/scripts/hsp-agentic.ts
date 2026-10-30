/**
 * HSP Agentic Payment (QA) setup checks. Nothing here signs, approves, funds or pays.
 *
 *   pnpm hsp:agentic health        the one GET /health allowed before allowlisting (recorded; not repeated)
 *   pnpm hsp:agentic tools         (after allowlisting) the eight tools, their descriptions and live input
 *                                  schemas → deployments/hsp-qa-tools.json, for review before any call
 *   pnpm hsp:agentic diff          the saved live schemas against the emulator's: same, adapted (clearly
 *                                  equivalent names) or STOP (ambiguous, missing, extra-required); offline
 *   pnpm hsp:agentic chain-config  (after allowlisting) the networks and tokens HSP offers
 *   pnpm hsp:agentic commands      the exact manual commands for the team (balance check, Permit2 approval
 *                                  when the token uses it), printed for a person to run; never run here
 *
 * Allowlisting is confirmed by setting HSP_ALLOWLISTED=1. HSP_CHAIN_ID / HSP_TOKEN choose among several
 * offered network/token combinations; HSP_PAYER is the payer wallet the user has confirmed.
 */
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { chooseOption, paymentOptions } from "../src/hsp/agentic/chainConfig.js";
import { HSP_MCP_URL, HspAgentic, healthCheck, type ToolInfo } from "../src/hsp/agentic/client.js";
import { emulatorTools } from "../src/hsp/agentic/emulator.js";
import { diffReport, diffSchemas } from "../src/hsp/agentic/schemaDiff.js";

const root = fileURLToPath(new URL("../../", import.meta.url));
const healthFile = `${root}deployments/hsp-qa-health.json`;
const cmd = process.argv[2];

async function main() {
  if (cmd === "health") {
    if (existsSync(healthFile) && process.env.HSP_ALLOWLISTED !== "1") {
      const prev = JSON.parse(readFileSync(healthFile, "utf8"));
      console.log(`Already checked at ${prev.at}: ${prev.ok ? "ok" : `not ok (${prev.status ?? "no answer"})`}. Not repeating until the allowlisting is confirmed (HSP_ALLOWLISTED=1).`);
      return;
    }
    const r = await healthCheck(HSP_MCP_URL);
    writeFileSync(healthFile, JSON.stringify({ at: new Date().toISOString(), url: new URL("health", HSP_MCP_URL).toString(), ...r }, null, 2) + "\n");
    console.log(`GET ${new URL("health", HSP_MCP_URL)}: ${r.status ?? "no answer"} ${r.ok ? "ok" : "not ok"} (${r.body})`);
    console.log("This confirms the process is alive, not tool availability or payment execution.");
    return;
  }

  if (cmd === "diff") {
    const file = `${root}deployments/hsp-qa-tools.json`;
    if (!existsSync(file)) {
      console.log("Needs the live schemas first: `HSP_ALLOWLISTED=1 pnpm hsp:agentic tools` (after HashKey confirms the allowlisting).");
      return;
    }
    const live = (JSON.parse(readFileSync(file, "utf8")) as { tools: ToolInfo[] }).tools;
    const report = diffReport(diffSchemas(live, await emulatorTools()));
    writeFileSync(`${root}deployments/hsp-qa-schema-diff.txt`, report + "\n");
    console.log(report);
    return;
  }

  if (cmd === "commands") {
    const cfgFile = `${root}deployments/hsp-qa-chain-config.json`;
    if (!existsSync(cfgFile)) {
      console.log("Needs get_chain_config's answer first: run `pnpm hsp:agentic chain-config` after HashKey confirms the allowlisting.");
      return;
    }
    const opt = chooseOption(JSON.parse(readFileSync(cfgFile, "utf8")), { chainId: process.env.HSP_CHAIN_ID ? Number(process.env.HSP_CHAIN_ID) : undefined, token: process.env.HSP_TOKEN });
    // The payer is confirmed with the user separately (guide §6), then given here; never defaulted.
    const brand = process.env.HSP_PAYER ?? "<payer address, confirmed with you: HSP_PAYER=0x…>";
    const rpc = opt.chainId === 133 ? "https://testnet.hsk.xyz" : "<RPC for chain " + opt.chainId + ">";
    const one = `1${"0".repeat(opt.token.decimals)}`;
    console.log(`For the team to run by hand (the agent never runs these). Token ${opt.token.symbol} ${opt.token.address} on ${opt.network} (chain ${opt.chainId}), ${opt.token.protocol}.`);
    console.log(`\n1. Balance of the payer wallet (the exact token contract):\n   cast call ${opt.token.address} "balanceOf(address)(uint256)" ${brand} --rpc-url ${rpc}`);
    console.log(`   Fund it with this token by hand if it's below the quoted token_total_raw.`);
    if (opt.token.protocol === "permit2") {
      const p2 = (JSON.parse(readFileSync(cfgFile, "utf8")) as { permit2?: string }).permit2;
      console.log(
        `\n2. Permit2 approval (once), for 1 ${opt.token.symbol} (${one} raw units):\n   cast send ${opt.token.address} "approve(address,uint256)" ${p2 ?? "<Permit2 address from HSP's chain config or docs>"} ${one} --keystore ${root}.secrets/keystores/brand --rpc-url ${rpc}`,
      );
      if (!p2) console.log("   get_chain_config didn't name the Permit2 contract: confirm it with HashKey before approving.");
    } else {
      console.log("\n2. No approval transaction: EIP-3009 authorizations are signed per payment.");
    }
    return;
  }

  if (cmd === "tools" || cmd === "chain-config") {
    const hsp = await HspAgentic.connectQa();
    try {
      if (cmd === "tools") {
        const out = [...hsp.tools.values()];
        writeFileSync(`${root}deployments/hsp-qa-tools.json`, JSON.stringify({ at: new Date().toISOString(), url: HSP_MCP_URL, tools: out }, null, 2) + "\n");
        for (const t of out) console.log(`${t.name}: required ${(t.inputSchema.required ?? []).join(", ") || "none"}; properties ${Object.keys(t.inputSchema.properties ?? {}).join(", ") || "none"}`);
        console.log(`All eight tools present. Schemas saved to deployments/hsp-qa-tools.json.`);
      } else {
        const cfg = await hsp.getChainConfig();
        writeFileSync(`${root}deployments/hsp-qa-chain-config.json`, JSON.stringify(cfg, null, 2) + "\n");
        for (const o of paymentOptions(cfg)) console.log(`${o.network} (chain ${o.chainId}): ${o.token.symbol} ${o.token.address}, ${o.token.decimals} decimals, ${o.token.protocol}`);
        console.log("Saved to deployments/hsp-qa-chain-config.json.");
      }
    } finally {
      await hsp.close();
    }
    return;
  }
  console.log("usage: pnpm hsp:agentic health | tools | diff | chain-config | commands");
}
main().catch((e) => {
  console.error(`FAILED: ${(e as Error).message}`);
  process.exit(1);
});
