import { appendFileSync, existsSync, readFileSync } from "node:fs";

/**
 * The message log the app shows: every A2A message, mandate, HSP call and transaction, in order.
 * Public data only. Callers never pass secrets; `redact` strips the few fields that could carry one
 * (credentials, keys, passwords) if they ever slip in.
 */
export interface LogEvent {
  seq: number;
  at: string; // ISO time
  actor: "brand-agent" | "creator-agent" | "hsp-gateway" | "render-agent" | "chain";
  kind:
    | "a2a.request"
    | "a2a.response"
    | "policy"
    | "cart-mandate"
    | "payment-mandate"
    | "hsp.request"
    | "hsp.response"
    | "hsp.webhook"
    | "tx"
    | "refused"
    | "error"
    | "info";
  summary: string;
  data?: unknown;
}

const SECRET_KEYS = /secret|password|private|app_?key|x-signature|authorization_header|mnemonic/i;

export function redact(value: unknown): unknown {
  if (value === null || typeof value !== "object") return value;
  if (Array.isArray(value)) return value.map(redact);
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
    out[k] = SECRET_KEYS.test(k) ? "[redacted]" : redact(v);
  }
  return out;
}

const json = (v: unknown) => JSON.stringify(v, (_k, x) => (typeof x === "bigint" ? x.toString() : x));

export class MessageLog {
  readonly events: LogEvent[] = [];
  private seq = 0;

  /** With a file, earlier events are reloaded so the history survives a restart. */
  constructor(private readonly file?: string) {
    if (file && existsSync(file)) {
      for (const line of readFileSync(file, "utf8").split("\n")) {
        if (!line.trim()) continue;
        try {
          const e = JSON.parse(line) as LogEvent;
          this.events.push(e);
          this.seq = Math.max(this.seq, e.seq);
        } catch {
          /* a partial line from a crash */
        }
      }
    }
  }

  add(actor: LogEvent["actor"], kind: LogEvent["kind"], summary: string, data?: unknown): LogEvent {
    const e: LogEvent = { seq: ++this.seq, at: new Date().toISOString(), actor, kind, summary, data: redact(JSON.parse(json(data ?? null))) };
    this.events.push(e);
    if (this.file) appendFileSync(this.file, `${json(e)}\n`);
    return e;
  }

  since(seq: number): LogEvent[] {
    return this.events.filter((e) => e.seq > seq);
  }
}
