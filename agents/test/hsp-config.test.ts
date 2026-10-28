import { generateKeyPairSync } from "node:crypto";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { loadHspConfig } from "../src/hsp/config.js";

describe("HSP credentials config", () => {
  const roots: string[] = [];
  afterEach(() => roots.splice(0).forEach((r) => rmSync(r, { recursive: true, force: true })));
  const setup = (creds: Record<string, unknown> | undefined, mode = 0o600, curve = "secp256k1") => {
    const root = `${mkdtempSync(join(tmpdir(), "likeness-hspcfg-"))}/`;
    roots.push(root);
    mkdirSync(`${root}.secrets/hsp`, { recursive: true });
    const { privateKey } = generateKeyPairSync("ec", { namedCurve: curve });
    writeFileSync(`${root}.secrets/hsp/merchant_private_key.pem`, privateKey.export({ type: "pkcs8", format: "pem" }));
    if (creds) {
      writeFileSync(`${root}.secrets/hsp/credentials.json`, JSON.stringify(creds));
      chmodSync(`${root}.secrets/hsp/credentials.json`, mode);
    }
    return root;
  };
  const full = { baseUrl: "https://merchant-qa.hashkeymerchant.com/", appKey: "ak_test", appSecret: "test-secret", permit2Spender: "0x000000000000000000000000000000000000bEEF" };

  it("no file: undefined (the emulator is used on testnet)", () => {
    expect(loadHspConfig(setup(undefined))).toBeUndefined();
  });

  it("loads with defaults", () => {
    const c = loadHspConfig(setup(full))!;
    expect(c.baseUrl).toBe("https://merchant-qa.hashkeymerchant.com");
    expect(c.payMandatePath).toBe("/api/v1/payment/pay-mandate");
    expect(c.jwtAudience).toBe("HashkeyMerchant");
    expect(c.recordAt).toBe("payment-included");
    expect(c.merchantKeyFingerprint).toMatch(/^[0-9a-f]{16}$/);
  });

  it("refuses a group- or world-readable file, missing fields, plain http, a non-secp256k1 key", () => {
    expect(() => loadHspConfig(setup(full, 0o644))).toThrow("chmod 600");
    expect(() => loadHspConfig(setup({ ...full, appSecret: "" }))).toThrow("appSecret");
    expect(() => loadHspConfig(setup({ ...full, baseUrl: "http://x" }))).toThrow("https");
    expect(() => loadHspConfig(setup(full, 0o600, "prime256v1"))).toThrow("secp256k1");
  });
});
