import { createHash } from "node:crypto";
import type { Hex, LocalAccount } from "viem";
import { hspSettlementAbi, type Likeness } from "../chain/contracts.js";
import type { MessageLog } from "../log.js";

/** Produces the file for a paid render. The real renderer (Gemini) plugs in here. */
export type Renderer = (input: { licenceId: bigint; renderIndex: number; brief: string }) => Promise<{ bytes: Uint8Array; mime: string }>;

/** A clearly marked placeholder, so the pipeline runs without a paid model. Never shown as a real ad. */
export const testRenderer: Renderer = async ({ licenceId, renderIndex, brief }) => {
  const esc = (s: string) => s.replace(/[<>&"]/g, (c) => `&#${c.charCodeAt(0)};`);
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="1024" height="1024"><rect width="100%" height="100%" fill="#111"/><text x="50%" y="45%" fill="#fff" font-size="64" text-anchor="middle" font-family="sans-serif">TEST RENDER</text><text x="50%" y="55%" fill="#aaa" font-size="28" text-anchor="middle" font-family="sans-serif">licence ${licenceId} · render ${renderIndex} · ${esc(brief).slice(0, 60)}</text></svg>`;
  return { bytes: new TextEncoder().encode(svg), mime: "image/svg+xml" };
};

export class RenderAgent {
  constructor(
    private readonly account: LocalAccount,
    private readonly chain: Likeness,
    private readonly log: MessageLog,
    private readonly renderer: Renderer = testRenderer,
  ) {}

  /** Renders only a paid render (payment recorded on chain), then anchors the file's receipt. */
  async renderAndAnchor(licenceId: bigint, renderIndex: number, brief: string) {
    const ch = this.chain;
    const p = await ch.payment(licenceId, renderIndex);
    if (p.recordedAt === 0n) throw new Error(`render ${renderIndex} of licence ${licenceId} is not paid`);
    const file = await this.renderer({ licenceId, renderIndex, brief });
    const assetHash = `0x${createHash("sha256").update(file.bytes).digest("hex")}` as Hex;
    const deadline = BigInt(Math.floor(Date.now() / 1000) + 300);
    const digest = await ch.renderDigest(licenceId, assetHash, renderIndex, deadline);
    if (!this.account.sign) throw new Error("render agent account cannot sign hashes");
    const signature = await this.account.sign({ hash: digest });
    const receipt = await ch.write(this.account, {
      address: ch.d.settlement,
      abi: hspSettlementAbi,
      functionName: "anchorRender",
      args: [licenceId, renderIndex, assetHash, this.account.address, deadline, signature],
    });
    this.log.add("chain", "tx", `receipt anchored for render ${renderIndex} of licence ${licenceId}`, { tx: receipt.transactionHash, assetHash });
    return { ...file, assetHash, tx: receipt.transactionHash };
  }
}
