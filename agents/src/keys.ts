import { createCipheriv, createDecipheriv, pbkdf2Sync, randomBytes, randomUUID, scryptSync } from "node:crypto";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { keccak256, nonceManager, toHex, type Hex, type LocalAccount } from "viem";
import { privateKeyToAccount } from "viem/accounts";

/**
 * Loads a wallet from an encrypted Web3 Secret Storage (v3) keystore, as written by
 * `cast wallet new <dir> <name>`. The key is decrypted in memory only; nothing is printed, logged or
 * written. The password comes from the macOS Keychain item the keystores were created with, or on a
 * server (Linux) from the root-only file named by LIKENESS_KEYSTORE_PASSWORD_FILE.
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
  const file = process.env.LIKENESS_KEYSTORE_PASSWORD_FILE;
  if (file) return readFileSync(file, "utf8").trimEnd();
  return execFileSync("security", ["find-generic-password", "-a", account, "-s", service, "-w"], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "ignore"],
  }).trimEnd();
}

/** The reverse of decryptKeystore: a v3 keystore (scrypt n=2^17, aes-128-ctr), as `cast wallet new` writes. */
export function encryptKeystore(privateKey: Hex, password: string): string {
  const salt = randomBytes(32);
  const iv = randomBytes(16);
  const n = 1 << 17;
  const key = scryptSync(password, salt, 32, { N: n, r: 8, p: 1, maxmem: 256 * n * 8 * 2 });
  const cipher = createCipheriv("aes-128-ctr", key.subarray(0, 16), iv);
  const ciphertext = Buffer.concat([cipher.update(Buffer.from(privateKey.slice(2), "hex")), cipher.final()]);
  const mac = keccak256(Buffer.concat([key.subarray(16, 32), ciphertext])).slice(2);
  key.fill(0);
  return JSON.stringify({
    crypto: { cipher: "aes-128-ctr", cipherparams: { iv: iv.toString("hex") }, ciphertext: ciphertext.toString("hex"), kdf: "scrypt", kdfparams: { dklen: 32, n, p: 1, r: 8, salt: salt.toString("hex") }, mac },
    id: randomUUID(),
    version: 3,
  });
}

/**
 * e.g. loadAccount(".secrets/keystores/brand"). Nonces are counted locally after the first lookup,
 * because a public RPC behind a load balancer can briefly report a stale nonce after a receipt.
 */
export function loadAccount(path: string, password: string = keychainPassword()): LocalAccount {
  return privateKeyToAccount(decryptKeystore(readFileSync(path, "utf8"), password), { nonceManager });
}
