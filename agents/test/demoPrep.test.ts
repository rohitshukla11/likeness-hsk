import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { PublicClient } from "viem";
import { afterAll, describe, expect, it } from "vitest";
import { Budget } from "../src/brand-agent/policy.js";
import { DemoPrep, type Limits } from "../src/app/demoPrep.js";
import { Confirmations } from "../src/app/jobs.js";

const NORMAL: Limits = { brand: { image: 3, video: 1 }, site: { image: 10, video: 2 }, paidRenders: 20, dailyBudget: 1_000_000n };

describe("demo prep: raised limits for one UTC day", () => {
  const dir = mkdtempSync(join(tmpdir(), "likeness-prep-"));
  afterAll(() => rmSync(dir, { recursive: true, force: true }));

  it("raises the limits on 4 Nov and lapses by itself at 00:00 UTC on 5 Nov (05:30 IST)", () => {
    let now = new Date("2026-11-04T06:00:00Z");
    const p = new DemoPrep(NORMAL, undefined, () => now);
    expect(p.limits()).toEqual(NORMAL);
    const v = p.raise();
    expect(v).toMatchObject({ active: true, day: "2026-11-04", until: "2026-11-05T00:00:00.000Z" });
    expect(p.limits()).toEqual({ brand: { image: 10, video: 4 }, site: { image: 20, video: 6 }, paidRenders: 26, dailyBudget: 2_000_000n });
    now = new Date("2026-11-04T23:59:59Z");
    expect(p.limits().brand.video).toBe(4);
    now = new Date("2026-11-05T00:00:00Z");
    expect(p.limits()).toEqual(NORMAL);
    expect(p.view()).toMatchObject({ active: false, day: null, until: null });
  });

  it("is kept in its file across restarts; restore ends it early", () => {
    const now = () => new Date("2026-11-04T06:00:00Z");
    const file = join(dir, "testnet-demo-prep.json");
    new DemoPrep(NORMAL, file, now).raise();
    const after = new DemoPrep(NORMAL, file, now);
    expect(after.view().active).toBe(true);
    after.restore();
    expect(new DemoPrep(NORMAL, file, now).limits()).toEqual(NORMAL);
  });

  it("never lowers a limit the server already sets higher", () => {
    const high: Limits = { brand: { image: 12, video: 1 }, site: { image: 30, video: 2 }, paidRenders: 40, dailyBudget: 5_000_000n };
    const p = new DemoPrep(high);
    p.raise();
    expect(p.limits()).toEqual({ brand: { image: 12, video: 4 }, site: { image: 30, video: 6 }, paidRenders: 40, dailyBudget: 5_000_000n });
  });

  it("the brand agent's budget follows the raised limit", () => {
    const b = new Budget({ maxPricePerRender: 150_000n, allowedCategories: 256, dailyBudget: 100_000n, maxRendersPerLicence: 5 });
    b.record(90_000n);
    expect(b.check(50_000n).ok).toBe(false);
    b.limit = () => 200_000n;
    expect(b.check(50_000n).ok).toBe(true);
  });
});

describe("confirmations while waiting for HSP's payment-safe", () => {
  const fake = (head: () => bigint) =>
    ({
      getTransactionReceipt: async () => ({ blockNumber: 100n }),
      getBlockNumber: async () => head(),
    }) as unknown as PublicClient;

  it("counts blocks since the payment's block on Sepolia, with the time left at 12 s a block", async () => {
    const c = new Confirmations(fake(() => 103n), 11155111, 12);
    expect(await c.of("0x01")).toEqual({ count: 4, target: 12, etaSeconds: 96 });
  });

  it("never goes backwards when a lagging node answers with an older head", async () => {
    let head = 110n;
    const c = new Confirmations(fake(() => head), 11155111, 12);
    expect((await c.of("0x01"))?.count).toBe(11);
    head = 104n;
    (c as unknown as { head: { at: number } }).head.at = 0; // the cached head is stale
    expect((await c.of("0x01"))?.count).toBe(11);
  });

  it("past the target, nothing left to wait for but HSP's next check; unknown block time: no counter", async () => {
    expect(await new Confirmations(fake(() => 130n), 11155111, 12).of("0x01")).toEqual({ count: 31, target: 12, etaSeconds: 0 });
    expect(await new Confirmations(fake(() => 130n), 133, 12).of("0x01")).toBeUndefined();
  });
});
