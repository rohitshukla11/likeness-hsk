/** What the brand lets its payment agent agree to and spend. Amounts in stablecoin base units. */
export interface BrandPolicy {
  maxPricePerRender: bigint;
  allowedCategories: number; // Categories bitmask the brand may license
  dailyBudget: bigint; // per UTC day, across all creators
  maxRendersPerLicence: number;
}

export interface TermsView {
  pricePerRender: bigint;
  categories: number;
  maxRenders: number;
  autoApprove: boolean;
  acceptingLicences: boolean;
}

export type Verdict = { ok: true } | { ok: false; reason: string };

/** Does the brand accept these terms for this category at all? */
export function checkTerms(p: BrandPolicy, t: TermsView, category: number): Verdict {
  if (!t.acceptingLicences) return { ok: false, reason: "creator is not accepting licences" };
  if ((t.categories & category) !== category) return { ok: false, reason: "the creator does not allow this use" };
  if ((p.allowedCategories & category) !== category) return { ok: false, reason: "this use is outside the brand's policy" };
  if (t.pricePerRender > p.maxPricePerRender) {
    return { ok: false, reason: `price ${t.pricePerRender} is above the brand's maximum ${p.maxPricePerRender} per render` };
  }
  return { ok: true };
}

/** Daily spend tracking (UTC day). In memory; the log keeps the history. */
export class Budget {
  private day = "";
  private spent = 0n;

  constructor(readonly policy: BrandPolicy, private readonly now: () => Date = () => new Date()) {}

  private roll() {
    const d = this.now().toISOString().slice(0, 10);
    if (d !== this.day) {
      this.day = d;
      this.spent = 0n;
    }
  }

  check(amount: bigint): Verdict {
    this.roll();
    if (amount > this.policy.maxPricePerRender) return { ok: false, reason: `amount ${amount} is above the per-render maximum` };
    if (this.spent + amount > this.policy.dailyBudget) {
      return { ok: false, reason: `daily budget: ${this.spent} of ${this.policy.dailyBudget} spent, ${amount} more would exceed it` };
    }
    return { ok: true };
  }

  record(amount: bigint) {
    this.roll();
    this.spent += amount;
  }

  get spentToday(): bigint {
    this.roll();
    return this.spent;
  }
}
