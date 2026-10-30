/**
 * HSP Agentic Payment over MCP (HashKey's guide "HSP Agentic Payment — Setup and Execution Guide", QA,
 * rev 2026-10-30). One client for both modes: HashKey's QA server over Streamable HTTP, or the offline
 * emulator (./emulator.ts) over an in-memory transport. App Key and App Secret live on HSP's server.
 *
 * Rules from the guide, enforced here:
 * - All eight tools must be listed before anything is called (finalize_payment above all).
 * - Arguments are checked against each tool's live input schema before every call. Each name the guide
 *   uses is looked for in the schema as itself, in camelCase, or as an explicit synonym (EQUIVALENT); one
 *   match is used (and recorded in `adaptations`), none for a value we must send or more than one is a
 *   stop, and so is a property the schema requires that this flow doesn't know. Nothing is guessed.
 * - Answers in camelCase get the guide's snake_case names too (top level and `payment` only; the eip712,
 *   payloads and mandates are passed on exactly as returned).
 * - Returned objects are passed on in the types the next schema asks for, contents unchanged.
 * - The live server is never contacted until its operator confirms our egress IP is allowlisted
 *   (HSP_ALLOWLISTED=1); before that only one health check is made, by hand.
 */
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";

export const HSP_MCP_URL = "https://mcp-qa.hashkeymerchant.com/";
/** The MCP configuration key HashKey asks for. */
export const HSP_MCP_KEY = "hsp-agentic-payment";
/** Our team's reporting name: the same exact string at order creation and in every query. */
export const MERCHANT_NAME = "Likeness";

export const HSP_TOOLS = ["get_chain_config", "create_order", "get_order", "prepare_payment", "finalize_payment", "estimate_fee", "submit_payment", "query_payment"] as const;
export type HspTool = (typeof HSP_TOOLS)[number];

/** HSP's payment states (guide §8), in order; payment-timeout and payment-failed are off the main path. */
export const PAYMENT_STATES = ["payment-submitted", "payment-verified", "payment-processing", "payment-included", "payment-safe", "payment-finalized"] as const;
export type PaymentState = (typeof PAYMENT_STATES)[number] | "payment-timeout" | "payment-failed";

/** The quote expired: prepare again and sign the new eip712 (guide §7). */
export const QUOTE_EXPIRED_CODE = 30043;

export interface Eip712Data {
  domain: Record<string, unknown>;
  types: Record<string, { name: string; type: string }[]>;
  primaryType: string;
  message: Record<string, unknown>;
}
export interface PreparedPayment {
  eip712: Eip712Data;
  cart_hash: string;
  token_total_raw: string;
  quote_expires_at: string;
  pay_to: string;
  payer: string;
  payment_request_id: string;
  payment_payload: unknown;
  payment_mandate_contents: unknown;
  [k: string]: unknown;
}
export interface CreatedOrder {
  flow_id: string;
  payment_request_id: string;
  payment_url?: string;
  [k: string]: unknown;
}
/** query_payment's answer: the status and payment fields the guide names; anything else kept as returned. */
export interface PaymentQuery {
  status?: string;
  attribution_verified?: boolean;
  payment?: { status?: string; status_reason?: string; tx_signature?: string; network?: string; to_pay_address?: string; payer_address?: string; [k: string]: unknown };
  [k: string]: unknown;
}

type JsonSchema = { type?: string | string[]; properties?: Record<string, JsonSchema>; required?: string[]; additionalProperties?: unknown; description?: string };
export interface ToolInfo {
  name: string;
  description?: string;
  inputSchema: JsonSchema;
}

export class HspToolError extends Error {
  constructor(
    readonly tool: string,
    message: string,
    /** HSP's error code when the message carries one (e.g. 30043, quote expired). */
    readonly code?: number,
  ) {
    super(`${tool}: ${message}`);
  }
}
export class HspSchemaMismatch extends Error {}

/**
 * Names the guide uses, and the other spellings that clearly mean the same thing. Only what the guide
 * itself supports: the payer's address is "payer" in prepare_payment's answer and "payer_address" in
 * query_payment's. Anything else must match by name or by camelCase.
 */
export const EQUIVALENT: Record<string, string[]> = { payer: ["payer_address"] };

const camel = (s: string) => s.replace(/_([a-z0-9])/g, (_, c: string) => c.toUpperCase());
const snake = (s: string) => s.replace(/[A-Z]/g, (c) => `_${c.toLowerCase()}`);

/** The one health check allowed before allowlisting: GET /health, one attempt, no retries. */
export async function healthCheck(base = HSP_MCP_URL, timeoutMs = 8000): Promise<{ ok: boolean; status: number | null; body: string }> {
  try {
    const r = await fetch(new URL("health", base), { signal: AbortSignal.timeout(timeoutMs) });
    const body = (await r.text()).slice(0, 200);
    return { ok: r.ok && /"status"\s*:\s*"ok"/.test(body), status: r.status, body };
  } catch (e) {
    return { ok: false, status: null, body: (e as Error).message.slice(0, 200) };
  }
}

export class HspAgentic {
  private constructor(
    private readonly client: Client,
    readonly tools: Map<string, ToolInfo>,
    /** "hashkey-qa" (HashKey's MCP server) or "emulator" (offline). */
    readonly source: "hashkey-qa" | "emulator",
  ) {}

  /** Where a live name differed from the guide's and was mapped ("prepare_payment.payer → payerAddress"). */
  readonly adaptations = new Set<string>();

  /** HashKey's QA server. Refuses until the allowlisting is confirmed (HSP_ALLOWLISTED=1). */
  static async connectQa(url = HSP_MCP_URL): Promise<HspAgentic> {
    if (process.env.HSP_ALLOWLISTED !== "1") throw new Error("HSP QA: our egress IP isn't confirmed as allowlisted yet (set HSP_ALLOWLISTED=1 once HashKey confirms); not connecting");
    return HspAgentic.connect(new StreamableHTTPClientTransport(new URL(url)), "hashkey-qa");
  }

  /** Any transport: the in-memory one for the offline emulator and tests. */
  static async connect(transport: Transport, source: "hashkey-qa" | "emulator"): Promise<HspAgentic> {
    const client = new Client({ name: "likeness-agents", version: "0.1.0" });
    await client.connect(transport);
    const listed = await client.listTools();
    const tools = new Map(listed.tools.map((t) => [t.name, { name: t.name, description: t.description, inputSchema: t.inputSchema as JsonSchema }]));
    const missing = HSP_TOOLS.filter((t) => !tools.has(t));
    if (missing.length) {
      await client.close();
      throw new Error(`HSP Agentic Payment is missing tool(s): ${missing.join(", ")}; stopping (no payment without all eight)`);
    }
    return new HspAgentic(client, tools, source);
  }

  close() {
    return this.client.close();
  }

  // ---------------------------------------------------------------- the eight tools

  getChainConfig() {
    return this.call<Record<string, unknown>>("get_chain_config", {});
  }
  /** cart_mandate: { contents } only; no merchant_authorization (guide §6). */
  createOrder(a: { merchant_name: string; pay_to: string; cart_mandate: { contents: unknown } }) {
    return this.call<CreatedOrder>("create_order", a);
  }
  getOrder(flowId: string) {
    return this.call<Record<string, unknown>>("get_order", { flow_id: flowId });
  }
  /** The payer's parameter name comes from the live schema (payer or payer_address). */
  preparePayment(a: { flow_id: string; payer: string; protocol: "eip3009" | "permit2" }) {
    return this.call<PreparedPayment>("prepare_payment", a);
  }
  finalizePayment(a: { signature: string; payment_payload: unknown; payment_mandate_contents: unknown; cart_hash: string }) {
    return this.call<{ payment_mandate_json: unknown; [k: string]: unknown }>("finalize_payment", a);
  }
  /** Arguments as the live schema describes them; not used in the payment flow. */
  estimateFee(args: Record<string, unknown>) {
    return this.call<Record<string, unknown>>("estimate_fee", args);
  }
  /** payment_mandate_json exactly as finalize_payment returned it. */
  submitPayment(paymentMandateJson: unknown) {
    return this.call<Record<string, unknown>>("submit_payment", { payment_mandate_json: paymentMandateJson });
  }
  /** Both identifiers when the schema takes both, otherwise the one it takes (at least one must fit). */
  queryPayment(ids: { flow_id?: string; payment_request_id?: string }, expectedMerchantName = MERCHANT_NAME) {
    const optional = new Set(["flow_id", "payment_request_id"].filter((k) => this.resolve("query_payment", k) === undefined));
    if (optional.size === 2) throw new HspSchemaMismatch("query_payment: its live schema takes neither flow_id nor payment_request_id; stopping");
    return this.call<PaymentQuery>("query_payment", { expected_merchant_name: expectedMerchantName, ...ids }, optional);
  }

  // ---------------------------------------------------------------- schema checks and calls

  /**
   * The live schema's name for one of the guide's: itself, its camelCase spelling, or an EQUIVALENT
   * synonym. Undefined when none is there; a stop when more than one is (ambiguous).
   */
  resolve(tool: HspTool, name: string): string | undefined {
    const props = this.tools.get(tool)!.inputSchema.properties ?? {};
    const found = [...new Set([name, camel(name), ...(EQUIVALENT[name] ?? []), ...(EQUIVALENT[name] ?? []).map(camel)])].filter((c) => c in props);
    if (found.length > 1) throw new HspSchemaMismatch(`${tool}: "${name}" could be any of ${found.join(", ")} in its live schema; stopping to ask rather than guess`);
    return found[0];
  }

  /** Arguments under the live schema's names and in its types, contents unchanged. `optional` may be absent. */
  conform(tool: HspTool, args: Record<string, unknown>, optional: Set<string> = new Set()): Record<string, unknown> {
    const schema = this.tools.get(tool)!.inputSchema;
    const props = schema.properties ?? {};
    const open = !Object.keys(props).length;
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(args)) {
      if (v === undefined) continue;
      const live = open ? k : this.resolve(tool, k);
      if (!live) {
        if (optional.has(k)) continue;
        throw new HspSchemaMismatch(`${tool}: nothing in its live schema matches "${k}" (it has ${Object.keys(props).join(", ")}); stopping to ask rather than guess`);
      }
      if (live in out) throw new HspSchemaMismatch(`${tool}: two of our values map to "${live}"; stopping`);
      if (live !== k) this.adaptations.add(`${tool}.${k} → ${live}`);
      out[live] = props[live] ? asType(props[live]!, v, `${tool}.${live}`) : v;
    }
    const missing = (schema.required ?? []).filter((r) => !(r in out));
    if (missing.length) throw new HspSchemaMismatch(`${tool}: the live schema requires ${missing.join(", ")}, which this flow doesn't know; stopping to ask`);
    return out;
  }

  async call<T>(tool: HspTool, args: Record<string, unknown>, optional?: Set<string>): Promise<T> {
    const r = await this.client.callTool({ name: tool, arguments: this.conform(tool, args, optional) });
    const text = ((r.content as { type: string; text?: string }[] | undefined) ?? []).filter((c) => c.type === "text").map((c) => c.text ?? "").join("\n");
    if (r.isError) throw new HspToolError(tool, text.slice(0, 500) || "error", codeIn(text));
    let v: unknown = r.structuredContent;
    if (v === undefined) {
      try {
        v = JSON.parse(text);
      } catch {
        throw new HspToolError(tool, `answer isn't JSON: ${text.slice(0, 200)}`);
      }
    }
    // An envelope with a non-zero code is an error; with code 0, its data is the answer.
    if (v && typeof v === "object" && typeof (v as { code?: unknown }).code === "number") {
      const e = v as { code: number; msg?: string; message?: string; data?: unknown };
      if (e.code !== 0) throw new HspToolError(tool, e.msg ?? e.message ?? `code ${e.code}`, e.code);
      if ("data" in e) v = e.data;
    }
    return withGuideNames(v) as T;
  }
}

/** A returned value in the type a schema property asks for: objects as JSON strings or back, unchanged. */
function asType(p: JsonSchema, v: unknown, where: string): unknown {
  const types = Array.isArray(p.type) ? p.type : p.type ? [p.type] : [];
  if (!types.length || types.includes(typeof v === "object" && v !== null ? (Array.isArray(v) ? "array" : "object") : typeof v)) return v;
  if (types.includes("string") && typeof v === "object" && v !== null) return JSON.stringify(v);
  if (types.includes("object") && typeof v === "string") {
    try {
      return JSON.parse(v);
    } catch {
      throw new HspSchemaMismatch(`${where}: the schema wants an object and the value is a non-JSON string`);
    }
  }
  if (types.includes("integer") || types.includes("number")) return v;
  throw new HspSchemaMismatch(`${where}: the schema wants ${types.join("|")}, the value is ${typeof v}`);
}

/** HSP's five-digit error code in a message, if any (e.g. 30043). */
export function codeIn(text: string): number | undefined {
  const m = /\b([1-9]\d{4})\b/.exec(text);
  return m ? Number(m[1]) : undefined;
}

/**
 * camelCase answer fields also under the guide's snake_case names (flowId → flow_id), at the top level and
 * in `payment`. Nested objects such as eip712, payment_payload and payment_mandate_contents are untouched.
 */
export function withGuideNames(v: unknown): unknown {
  if (!v || typeof v !== "object" || Array.isArray(v)) return v;
  const add = (o: Record<string, unknown>) => {
    const out: Record<string, unknown> = { ...o };
    for (const [k, x] of Object.entries(o)) {
      const s = snake(k);
      if (s !== k && !(s in out)) out[s] = x;
    }
    return out;
  };
  const top = add(v as Record<string, unknown>);
  if (top.payment && typeof top.payment === "object" && !Array.isArray(top.payment)) top.payment = add(top.payment as Record<string, unknown>);
  return top;
}

