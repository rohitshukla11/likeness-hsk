import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomBytes } from "node:crypto";
import { privateKeyToAccount } from "viem/accounts";
import { afterAll, describe, expect, it } from "vitest";
import { decryptKeystore, encryptKeystore } from "../src/keys.js";
import { generatePrivateKey } from "viem/accounts";
import { foundryBin } from "../src/dev/foundry.js";

const cast = foundryBin("cast");

describe("keystores (cast wallet new)", () => {
  const dir = mkdtempSync(join(tmpdir(), "likeness-hsk-ks-"));
  const password = randomBytes(24).toString("base64");
  afterAll(() => rmSync(dir, { recursive: true, force: true }));

  it("decrypts a throwaway keystore to the address cast reported, in memory", () => {
    const r = spawnSync(cast, ["wallet", "new", dir, "throwaway"], { env: { ...process.env, CAST_PASSWORD: password }, encoding: "utf8" });
    const out = `${r.stdout}${r.stderr}`;
    const address = /Address:\s+(0x[0-9a-fA-F]{40})/.exec(out)?.[1];
    expect(address).toBeDefined();
    const pk = decryptKeystore(readFileSync(join(dir, "throwaway"), "utf8"), password);
    expect(privateKeyToAccount(pk).address).toBe(address);
  });

  it("refuses a wrong password", () => {
    expect(() => decryptKeystore(readFileSync(join(dir, "throwaway"), "utf8"), "wrong")).toThrow("wrong keystore password");
  });

  it("writes a keystore it (and cast's format) can read back, only with the right password", () => {
    const pk = generatePrivateKey();
    const ks = encryptKeystore(pk, password);
    expect(ks).not.toContain(pk.slice(2));
    expect(decryptKeystore(ks, password)).toBe(pk);
    expect(() => decryptKeystore(ks, "wrong")).toThrow("wrong keystore password");
  });
});
