/**
 * The public app's guards (LIKENESS_PUBLIC=1, behind Caddy): operator actions (license, pay, approve,
 * revoke) need the demo password, which buys a signed session cookie; every client IP is rate limited;
 * paid renders are capped per UTC day across restarts. Pages, Verify and the read-only API stay open.
 */
import { createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import type { IncomingMessage } from "node:http";

const COOKIE = "likeness_op";
const SESSION_SECONDS = 12 * 3600;

export class OperatorAuth {
  private readonly digest: Buffer;
  private readonly key = randomBytes(32); // per process: a restart signs everyone out
  constructor(password: string) {
    if (password.length < 12) throw new Error("the demo password must be at least 12 characters");
    this.digest = createHash("sha256").update(password).digest();
  }

  /** A Set-Cookie value for the right password, else undefined. */
  login(password: string): string | undefined {
    const given = createHash("sha256").update(password).digest();
    if (!timingSafeEqual(given, this.digest)) return undefined;
    const exp = Math.floor(Date.now() / 1000) + SESSION_SECONDS;
    return `${COOKIE}=${exp}.${this.sign(exp)}; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=${SESSION_SECONDS}`;
  }

  logout(): string {
    return `${COOKIE}=; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=0`;
  }

  check(req: IncomingMessage): boolean {
    const v = (req.headers.cookie ?? "").split(/;\s*/).find((c) => c.startsWith(`${COOKIE}=`))?.slice(COOKIE.length + 1);
    const [exp, sig] = (v ?? "").split(".");
    if (!exp || !sig || !/^\d+$/.test(exp) || Number(exp) < Date.now() / 1000) return false;
    const want = Buffer.from(this.sign(Number(exp)));
    const got = Buffer.from(sig);
    return got.length === want.length && timingSafeEqual(got, want);
  }

  private sign(exp: number) {
    return createHmac("sha256", this.key).update(`${COOKIE}:${exp}`).digest("base64url");
  }
}

/** A fixed one-minute window per key (client IP). */
export class RateLimit {
  private readonly hits = new Map<string, { start: number; n: number }>();
  constructor(readonly perMinute: number) {}

  allow(key: string): boolean {
    const now = Date.now();
    const h = this.hits.get(key);
    if (!h || now - h.start >= 60_000) {
      if (this.hits.size > 10_000) this.hits.clear();
      this.hits.set(key, { start: now, n: 1 });
      return true;
    }
    return ++h.n <= this.perMinute;
  }
}

/** Paid renders per UTC day, kept in a file so a restart doesn't reset it. */
export class DailyCap {
  constructor(
    private readonly file: string,
    readonly max: number,
  ) {}

  private today() {
    return new Date().toISOString().slice(0, 10);
  }

  count(): number {
    if (!existsSync(this.file)) return 0;
    const s = JSON.parse(readFileSync(this.file, "utf8")) as { day: string; paid: number };
    return s.day === this.today() ? s.paid : 0;
  }

  add() {
    writeFileSync(this.file, JSON.stringify({ day: this.today(), paid: this.count() + 1 }));
  }
}

export interface Guard {
  auth: OperatorAuth;
  reads: RateLimit;
  actions: RateLimit;
  logins: RateLimit;
  cap: DailyCap;
}

export function guardFromEnv(capFile: string): Guard | undefined {
  if (process.env.LIKENESS_PUBLIC !== "1") return undefined;
  const file = process.env.LIKENESS_DEMO_PASSWORD_FILE;
  if (!file) throw new Error("LIKENESS_PUBLIC=1 needs LIKENESS_DEMO_PASSWORD_FILE");
  return {
    auth: new OperatorAuth(readFileSync(file, "utf8").trimEnd()),
    reads: new RateLimit(300),
    actions: new RateLimit(20),
    logins: new RateLimit(5),
    cap: new DailyCap(capFile, 10),
  };
}

/** The client's IP: behind Caddy, the last X-Forwarded-For entry (the address Caddy saw). */
export function clientIp(req: IncomingMessage): string {
  const xff = req.headers["x-forwarded-for"];
  const last = (Array.isArray(xff) ? xff.join(",") : (xff ?? "")).split(",").at(-1)?.trim();
  return last || req.socket.remoteAddress || "unknown";
}
