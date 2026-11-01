import { createHash } from "node:crypto";
import type { Hex, LocalAccount } from "viem";
import { hspSettlementAbi, type Likeness } from "../chain/contracts.js";
import type { MessageLog } from "../log.js";

/** The creator a render is of: name, and the photo they consented to show (if any). */
export interface RenderSubject {
  name: string;
  photo?: { bytes: Uint8Array; mime: string };
}

/** Produces the file for a paid render: an AI image or video ad (src/ai), or the marked TEST RENDER. */
export type Renderer = (input: {
  licenceId: bigint;
  renderIndex: number;
  brief: string;
  subject?: RenderSubject;
  kind?: "image" | "video";
  /** The exact prompts for the model(s), as the brand approved them. */
  prompt?: string;
  motion?: string;
  onProgress?: (step: string) => void;
}) => Promise<{ bytes: Uint8Array; mime: string; model?: string; note?: string }>;

/**
 * A clearly marked placeholder, so the pipeline runs without a paid model. Never shown as a real ad.
 * With the creator's consented photo, the photo is composited under a TEST RENDER watermark.
 */
export const testRenderer: Renderer = async ({ licenceId, renderIndex, brief, subject }) => {
  const esc = (s: string) => s.replace(/[<>&"]/g, (c) => `&#${c.charCodeAt(0)};`);
  const caption = `licence ${licenceId} · render ${renderIndex} · ${esc(brief).slice(0, 60)}`;
  const svg = subject?.photo
    ? `<svg xmlns="http://www.w3.org/2000/svg" width="1024" height="1024"><rect width="100%" height="100%" fill="#111"/><image href="data:${subject.photo.mime};base64,${Buffer.from(subject.photo.bytes).toString("base64")}" x="0" y="0" width="1024" height="1024" preserveAspectRatio="xMidYMid slice"/><g fill="#fff" fill-opacity="0.22" font-family="sans-serif" font-weight="700" font-size="54" text-anchor="middle">${[180, 420, 660, 900].map((y) => `<text x="512" y="${y}" transform="rotate(-24 512 ${y})">TEST RENDER · TEST RENDER</text>`).join("")}</g><rect x="0" y="884" width="1024" height="140" fill="#111" fill-opacity="0.82"/><text x="40" y="944" fill="#DCF37B" font-size="38" font-weight="700" font-family="sans-serif">TEST RENDER · ${esc(subject.name).slice(0, 40)}</text><text x="40" y="992" fill="#ddd" font-size="24" font-family="sans-serif">${caption}</text></svg>`
    : `<svg xmlns="http://www.w3.org/2000/svg" width="1024" height="1024"><rect width="100%" height="100%" fill="#111"/><text x="50%" y="45%" fill="#fff" font-size="64" text-anchor="middle" font-family="sans-serif">TEST RENDER</text><text x="50%" y="55%" fill="#aaa" font-size="28" text-anchor="middle" font-family="sans-serif">${caption}</text></svg>`;
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
  async renderAndAnchor(licenceId: bigint, renderIndex: number, brief: string, subject?: RenderSubject, opts: { kind?: "image" | "video"; prompt?: string; motion?: string; onProgress?: (step: string) => void } = {}) {
    const ch = this.chain;
    const p = await ch.payment(licenceId, renderIndex);
    if (p.recordedAt === 0n) throw new Error(`render ${renderIndex} of licence ${licenceId} is not paid`);
    const file = await this.renderer({ licenceId, renderIndex, brief, subject, ...opts });
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
