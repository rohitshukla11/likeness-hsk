import { createDecipheriv, pbkdf2Sync, scryptSync } from "node:crypto";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { keccak256, nonceManager, toHex, type Hex, type LocalAccount } from "viem";
import { privateKeyToAccount } from "viem/accounts";

/**
 * Loads a wallet from an encrypted Web3 Secret Storage (v3) keystore, as written by
 * `cast wallet new <dir> <name>`. The key is decrypted in memory only; nothing is printed, logged or
 * written. The password comes from the macOS Keychain item the keystores were created with.
 */
export function decryptKeystore(json: string, password: string): Hex {
  const ks = JSON.parse(json);
  const c = ks.crypto ?? ks.Crypto;
  if (!c || c.cipher !== "aes-128-ctr") throw new Error("unsupported keystore");
  const salt = Buffer.from(c.kdfparams.salt, "hex");
  const dklen: number = c.kdfparams.dklen;
  let key: Buffer;
  if (c.kdf === "scrypt") {
    const { n, r, p } = c.kdfparams;
    key = scryptSync(password, salt, dklen, { N: n, r, p, maxmem: 256 * n * r * 2 });
  } else if (c.kdf === "pbkdf2") {
    if (c.kdfparams.prf !== "hmac-sha256") throw new Error("unsupported pbkdf2 prf");
    key = pbkdf2Sync(password, salt, c.kdfparams.c, dklen, "sha256");
  } else {
    throw new Error(`unsupported kdf ${c.kdf}`);
  }
  const ciphertext = Buffer.from(c.ciphertext, "hex");
  const mac = keccak256(Buffer.concat([key.subarray(16, 32), ciphertext]));
  if (mac.slice(2).toLowerCase() !== String(c.mac).toLowerCase()) throw new Error("wrong keystore password");
  const decipher = createDecipheriv("aes-128-ctr", key.subarray(0, 16), Buffer.from(c.cipherparams.iv, "hex"));
  const pk = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
  key.fill(0);
  return toHex(pk);
}

export function keychainPassword(service = "likeness-hsk-keystore", account = "likeness-hsk"): string {
  return execFileSync("security", ["find-generic-password", "-a", account, "-s", service, "-w"], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "ignore"],
  }).trimEnd();
}

/**
 * e.g. loadAccount(".secrets/keystores/brand"). Nonces are counted locally after the first lookup,
 * because a public RPC behind a load balancer can briefly report a stale nonce after a receipt.
 */
export function loadAccount(path: string, password: string = keychainPassword()): LocalAccount {
  return privateKeyToAccount(decryptKeystore(readFileSync(path, "utf8"), password), { nonceManager });
}
