import { describe, expect, it } from "vitest";
import { Budget, checkTerms, type BrandPolicy } from "../src/brand-agent/policy.js";

const ADVERTISING = 1 << 8;
const SOCIAL = 1 << 9;
const policy: BrandPolicy = { maxPricePerRender: 100_000n, allowedCategories: ADVERTISING, dailyBudget: 250_000n, maxRendersPerLicence: 5 };
const terms = { pricePerRender: 50_000n, categories: ADVERTISING | SOCIAL, maxRenders: 10, autoApprove: true, acceptingLicences: true };

describe("brand policy", () => {
  it("accepts terms inside the policy", () => {
    expect(checkTerms(policy, terms, ADVERTISING)).toEqual({ ok: true });
  });

  it("refuses a closed creator, a use the creator forbids, a use the brand forbids, a high price", () => {
    expect(checkTerms(policy, { ...terms, acceptingLicences: false }, ADVERTISING).ok).toBe(false);
    expect(checkTerms(policy, { ...terms, categories: SOCIAL }, ADVERTISING).ok).toBe(false);
    expect(checkTerms(policy, terms, SOCIAL).ok).toBe(false);
    expect(checkTerms(policy, { ...terms, pricePerRender: 100_001n }, ADVERTISING).ok).toBe(false);
  });

  it("daily budget per UTC day", () => {
    let now = new Date("2026-10-28T23:59:00Z");
    const b = new Budget(policy, () => now);
    b.record(100_000n);
    b.record(100_000n);
    expect(b.check(50_000n).ok).toBe(true);
    expect(b.check(50_001n).ok).toBe(false);
    expect(b.check(100_001n).ok).toBe(false); // above the per-render maximum
    now = new Date("2026-10-29T00:00:01Z");
    expect(b.spentToday).toBe(0n);
    expect(b.check(100_000n).ok).toBe(true);
  });
});
