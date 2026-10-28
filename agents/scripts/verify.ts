// Verifies the deployed contracts' source on Blockscout (flattened source; the explorer's proxy rejects
// the standard-JSON upload as too large). Read-only for the chain; it only talks to the explorer.
//
//   pnpm run verify -- --network testnet|mainnet
// Results are "partially verified": flattening changes the metadata hash at the end of the bytecode,
// while the code itself matches exactly. To fit the testnet explorer's upload limit (about 100 KB),
// comments and indentation are removed from every section except the verified contract's own file, which keeps all
// of its comments (each contract is verified with its own file in full).
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const args = process.argv.slice(2);
const network = args[args.indexOf("--network") + 1];
if (network !== "testnet" && network !== "mainnet") throw new Error("--network testnet|mainnet");
const root = fileURLToPath(new URL("../../", import.meta.url));
const dep = JSON.parse(readFileSync(`${root}deployments/${network}.json`, "utf8"));
const forge = join(homedir(), ".foundry/bin/forge");
const COMPILER = "v0.8.30+commit.73712a01";
const contracts: [string, string, string][] = [
  ["CreatorRegistry", "src/CreatorRegistry.sol", dep.creators],
  ["LicenseRegistry", "src/LicenseRegistry.sol", dep.licences],
  ["ReceiptAnchor", "src/ReceiptAnchor.sol", dep.receipts],
  ["HspSettlement", "src/HspSettlement.sol", dep.settlement],
  ...(dep.testToken ? ([["TestUSDT", "src/testnet/TestUSDT.sol", dep.token]] as [string, string, string][]) : []),
];

// Removes line and block comments outside string literals.
function stripComments(code: string): string {
  let out = "";
  for (let i = 0; i < code.length; ) {
    const c = code[i]!;
    if (c === '"' || c === "'") {
      let j = i + 1;
      while (j < code.length && code[j] !== c) j += code[j] === "\\" ? 2 : 1;
      out += code.slice(i, j + 1);
      i = j + 1;
    } else if (code.startsWith("//", i)) {
      while (i < code.length && code[i] !== "\n") i++;
    } else if (code.startsWith("/*", i)) {
      const end = code.indexOf("*/", i + 2);
      i = end < 0 ? code.length : end + 2;
    } else {
      out += c;
      i++;
    }
  }
  // Formatting only: drop indentation and blank lines (the code is unchanged).
  return out
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l.length > 0)
    .join("\n");
}

/** Strips comments from every section of a flattened file except `keep` (e.g. "src/HspSettlement.sol"). */
function slim(flat: string, keep: string): string {
  const parts = flat.split(/^(?=\/\/ (?:src|lib)\/)/m);
  return parts
    .map((p) => {
      const header = p.slice(0, p.indexOf("\n") + 1);
      if (!/^\/\/ (src|lib)\//.test(header) || header.trim() === `// ${keep}`) return p;
      return `${header}${stripComments(p.slice(header.length))}`;
    })
    .join("");
}

// curl, because the explorers' Cloudflare blocks some HTTP clients.
const curl = (url: string, bodyFile?: string) =>
  execFileSync("curl", ["-s", ...(bodyFile ? ["-X", "POST", "-H", "content-type: application/json", "--data-binary", `@${bodyFile}`] : []), url], { encoding: "utf8" });
const status = (addr: string) => {
  const d = JSON.parse(curl(`${dep.explorer}/api/v2/smart-contracts/${addr}`) || "{}");
  return d.is_verified ? (d.is_partially_verified ? "verified (partial: metadata hash)" : "verified") : "not verified";
};

const dir = mkdtempSync(join(tmpdir(), "likeness-verify-"));
try {
  for (const [name, path, addr] of contracts) {
    if (status(addr).startsWith("verified")) {
      console.log(`${name.padEnd(16)} ${addr} already ${status(addr)}`);
      continue;
    }
    const source = slim(execFileSync(forge, ["flatten", path], { cwd: `${root}contracts`, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }), path);
    const body = join(dir, `${name}.json`);
    writeFileSync(
      body,
      JSON.stringify({
        compiler_version: COMPILER,
        source_code: source,
        is_optimization_enabled: true,
        optimization_runs: 10000,
        contract_name: name,
        libraries: {},
        evm_version: "cancun",
        autodetect_constructor_args: true,
        license_type: "mit",
      }),
    );
    const res = curl(`${dep.explorer}/api/v2/smart-contracts/${addr}/verification/via/flattened-code`, body);
    let s = "not verified";
    for (let i = 0; i < 18 && !s.startsWith("verified"); i++) {
      execFileSync("sleep", ["5"]);
      s = status(addr);
    }
    console.log(`${name.padEnd(16)} ${addr} ${s}  ${dep.explorer}/address/${addr}${s.startsWith("verified") ? "" : `  (${res.slice(0, 120)})`}`);
  }
} finally {
  rmSync(dir, { recursive: true, force: true });
}
