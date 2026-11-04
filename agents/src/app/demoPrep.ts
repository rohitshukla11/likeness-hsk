/**
 * The admin's "demo prep": higher daily limits for the UTC day it is set on (AI ads per brand account and
 * across the server, paid renders, the brand agent's daily budget). Kept in a file on the public server so a
 * restart keeps them; they lapse by themselves at the next 00:00 UTC (05:30 IST), when every daily count
 * starts again anyway, so nothing has to restore them. Restore ends them early.
 */
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import type { AdKind } from "./accounts.js";

export type Caps = Record<AdKind, number>;

export interface Limits {
  brand: Caps;
  site: Caps;
  /** Paid renders a UTC day across the server (the public guard's cap). */
  paidRenders: number;
  /** The brand agent's daily budget, in token base units (the brand accounts share its wallet). */
  dailyBudget: bigint;
}

/** 10 images and 4 videos per brand, 20 and 6 across the server; the budget covers them at the price caps. */
export const DEMO_PREP: Limits = { brand: { image: 10, video: 4 }, site: { image: 20, video: 6 }, paidRenders: 26, dailyBudget: 2_000_000n };

export interface DemoPrepView {
  active: boolean;
  /** The UTC day the raised limits apply to, and when they lapse (the next 00:00 UTC). */
  day: string | null;
  until: string | null;
  limits: { brand: Caps; site: Caps; paidRenders: number; dailyBudget: string };
  /** What raising gives (today's limits while it is on). */
  raised: { brand: Caps; site: Caps; paidRenders: number; dailyBudget: string };
  normal: { brand: Caps; site: Caps; paidRenders: number; dailyBudget: string };
}

const utcDay = (d: Date) => d.toISOString().slice(0, 10);
const nextMidnight = (day: string) => new Date(Date.parse(`${day}T00:00:00Z`) + 86_400_000).toISOString();
const atLeast = (a: Caps, b: Caps): Caps => ({ image: Math.max(a.image, b.image), video: Math.max(a.video, b.video) });
const show = (l: Limits) => ({ brand: l.brand, site: l.site, paidRenders: l.paidRenders, dailyBudget: l.dailyBudget.toString() });

export class DemoPrep {
  private memo: string | undefined; // the raised day, when there is no file

  constructor(
    readonly normal: Limits,
    private readonly file?: string,
    private readonly now: () => Date = () => new Date(),
  ) {}

  private raisedDay(): string | undefined {
    if (!this.file) return this.memo;
    if (!existsSync(this.file)) return undefined;
    return (JSON.parse(readFileSync(this.file, "utf8")) as { day?: string }).day;
  }

  /** The UTC day the raised limits apply to, while it is today. */
  activeDay(): string | undefined {
    const d = this.raisedDay();
    return d && d === utcDay(this.now()) ? d : undefined;
  }

  /** Today's limits: raised (never below the normal ones) while demo prep is on, else the normal ones. */
  limits(): Limits {
    return this.activeDay() ? this.raised() : this.normal;
  }

  private raised(): Limits {
    const n = this.normal;
    return {
      brand: atLeast(n.brand, DEMO_PREP.brand),
      site: atLeast(n.site, DEMO_PREP.site),
      paidRenders: Math.max(n.paidRenders, DEMO_PREP.paidRenders),
      dailyBudget: n.dailyBudget > DEMO_PREP.dailyBudget ? n.dailyBudget : DEMO_PREP.dailyBudget,
    };
  }

  /** Raise the limits for today (UTC); they lapse at the next 00:00 UTC. */
  raise(): DemoPrepView {
    const day = utcDay(this.now());
    if (this.file) writeFileSync(this.file, JSON.stringify({ day, setAt: this.now().toISOString() }));
    else this.memo = day;
    return this.view();
  }

  /** Back to the normal limits now. */
  restore(): DemoPrepView {
    if (this.file) writeFileSync(this.file, JSON.stringify({ day: null, restoredAt: this.now().toISOString() }));
    else this.memo = undefined;
    return this.view();
  }

  view(): DemoPrepView {
    const day = this.activeDay();
    return { active: !!day, day: day ?? null, until: day ? nextMidnight(day) : null, limits: show(this.limits()), raised: show(this.raised()), normal: show(this.normal) };
  }
}
