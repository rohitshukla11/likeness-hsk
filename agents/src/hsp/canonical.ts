import { createHash } from "node:crypto";

/**
 * HSP's Canonical JSON (docs: cart-mandate.md, "Canonical JSON"; Node SDK crypto/canonical-json.ts):
 * object keys sorted recursively, compact, `undefined` members dropped. For the JSON values we send
 * (strings, integers, booleans, arrays, objects) this is the RFC 8785 serialisation: JavaScript's
 * default sort compares UTF-16 code units, and JSON.stringify writes numbers as ECMAScript does.
 */
export function canonicalJson(value: unknown): string {
  return JSON.stringify(sortKeys(value));
}

function sortKeys(value: unknown): unknown {
  if (value === null || typeof value !== "object") return value;
  if (Array.isArray(value)) return value.map(sortKeys);
  const sorted: Record<string, unknown> = {};
  for (const key of Object.keys(value as Record<string, unknown>).sort()) {
    const child = (value as Record<string, unknown>)[key];
    if (child !== undefined) sorted[key] = sortKeys(child);
  }
  return sorted;
}

export function sha256Hex(data: string | Uint8Array): string {
  return createHash("sha256").update(data).digest("hex");
}
