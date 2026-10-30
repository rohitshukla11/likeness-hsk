import { describe, expect, it } from "vitest";
import { listLicences, listPayments, type Runtime } from "../src/app/runtime.js";

const A = "0x00000000000000000000000000000000000000aa";
const B = "0x00000000000000000000000000000000000000bb";
const C = "0x00000000000000000000000000000000000000cc";

/** An RPC like HSK testnet's: eth_getLogs fails for ranges of 5,000 blocks or more. */
function fakeRuntime(start: bigint) {
  const chain = { latest: 20_000n, calls: [] as [bigint, bigint][] };
  const logs: Record<string, { blockNumber: bigint; transactionHash: string; args: Record<string, unknown> }[]> = {
    LicenceIssued: [
      { blockNumber: 1_500n, transactionHash: "0x01", args: { id: 1n, creator: A, licensee: B } },
      { blockNumber: 12_345n, transactionHash: "0x02", args: { id: 2n, creator: C, licensee: B } },
    ],
    PaymentRecorded: [{ blockNumber: 12_400n, transactionHash: "0x03", args: { licenceId: 1n, renderIndex: 0, payer: B, payout: A, amount: 50_000n, nonceBound: false, hspTxHash: "0x04" } }],
    RenderAnchored: [{ blockNumber: 12_401n, transactionHash: "0x05", args: { licenceId: 1n, renderIndex: 0, assetHash: "0x06" } }],
  };
  const pub = {
    getBlockNumber: async () => chain.latest,
    getLogs: async ({ event, fromBlock, toBlock }: { event: { name: string }; fromBlock: bigint; toBlock: bigint }) => {
      if (toBlock - fromBlock >= 5_000n) throw new Error("block range too large");
      chain.calls.push([fromBlock, toBlock]);
      return logs[event.name]!.filter((l) => l.blockNumber >= fromBlock && l.blockNumber <= toBlock);
    },
  };
  const rt = {
    startBlock: start,
    chain: {
      public: pub,
      d: { licences: "0x1111111111111111111111111111111111111111", settlement: "0x2222222222222222222222222222222222222222" },
      licence: async (id: bigint) => ({ creator: id === 1n ? A : C, licensee: B, renderCount: 0, renderCap: 3, pricePerRender: 50_000n, end: 0n }),
      status: async () => "Active",
    },
  } as unknown as Runtime;
  return { rt, logs, chain };
}

describe("reading logs from an RPC that limits eth_getLogs ranges", () => {
  it("scans in chunks the RPC accepts, filters in memory, then reads only new blocks", async () => {
    const { rt, logs, chain } = fakeRuntime(1_000n);
    expect((await listLicences(rt, { creator: A })).map((l) => l.id)).toEqual(["1"]);
    expect((await listLicences(rt, { licensee: B })).map((l) => l.id)).toEqual(["1", "2"]);
    expect(chain.calls.every(([a, b]) => b - a < 5_000n)).toBe(true);
    expect(chain.calls[0]![0]).toBe(1_000n);

    chain.calls.length = 0;
    chain.latest = 24_000n;
    logs.LicenceIssued!.push({ blockNumber: 23_000n, transactionHash: "0x07", args: { id: 3n, creator: A, licensee: B } });
    expect((await listLicences(rt, { creator: A })).map((l) => l.id)).toEqual(["1", "3"]);
    expect(chain.calls).toEqual([[20_001n, 24_000n]]);
  });

  it("joins payments with their receipts, for all or for one render", async () => {
    const { rt } = fakeRuntime(1_000n);
    const all = await listPayments(rt);
    expect(all).toHaveLength(1);
    expect(all[0]).toMatchObject({ licenceId: "1", renderIndex: 0, recordTx: "0x03", anchorTx: "0x05", assetHash: "0x06" });
    expect(await listPayments(rt, { licenceId: 1n, renderIndex: 0 })).toHaveLength(1);
    expect(await listPayments(rt, { licenceId: 2n, renderIndex: 0 })).toHaveLength(0);
  });
});
