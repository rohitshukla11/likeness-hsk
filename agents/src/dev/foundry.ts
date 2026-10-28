import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

/** A Foundry binary: ~/.foundry/bin when foundryup installed it there, else whatever is on PATH (CI). */
export function foundryBin(name: "anvil" | "cast" | "forge"): string {
  const local = join(homedir(), ".foundry/bin", name);
  return existsSync(local) ? local : name;
}
