import { recoverMessageAddress, type Address, type Hex } from "viem";
import type { Likeness } from "../chain/contracts.js";

/**
 * Downloading a licensed render needs the licensee's wallet signature. In likeness-arc anyone who knew
 * a file hash (public in the ReceiptAnchored event) could download the file. Here the server recovers
 * the signer of a short, dated message and serves the file only to the licence's licensee as recorded
 * on chain.
 */
export const CLAIM_WINDOW_MS = 5 * 60_000;

export function claimMessage(p: { assetHash: Hex; licenceId: bigint; chainId: number; issuedAt: string }): string {
  return [
    "Likeness: download a licensed render",
    `file: ${p.assetHash}`,
    `licence: ${p.licenceId}`,
    `chain: ${p.chainId}`,
    `issued: ${p.issuedAt}`,
  ].join("\n");
}

export class ClaimError extends Error {
  constructor(
    readonly status: 400 | 403 | 404,
    message: string,
  ) {
    super(message);
  }
}

/** Throws ClaimError unless `signature` is the licensee's, over this file's claim message, recently. */
export async function verifyClaim(
  chain: Likeness,
  req: { assetHash: Hex; issuedAt: string; signature: Hex },
  now = Date.now(),
): Promise<{ licenceId: bigint; licensee: Address }> {
  if (!/^0x[0-9a-fA-F]{64}$/.test(req.assetHash)) throw new ClaimError(400, "bad file hash");
  const issued = Date.parse(req.issuedAt);
  if (!Number.isFinite(issued) || Math.abs(now - issued) > CLAIM_WINDOW_MS) throw new ClaimError(403, "claim expired: sign a fresh one");
  const [found, receipt] = await chain.receiptOf(req.assetHash);
  if (!found) throw new ClaimError(404, "no receipt for this file");
  const licence = await chain.licence(receipt.licenceId);
  const message = claimMessage({ assetHash: req.assetHash, licenceId: receipt.licenceId, chainId: chain.d.chainId, issuedAt: req.issuedAt });
  let signer: Address;
  try {
    signer = await recoverMessageAddress({ message, signature: req.signature });
  } catch {
    throw new ClaimError(403, "bad signature");
  }
  if (signer.toLowerCase() !== licence.licensee.toLowerCase()) throw new ClaimError(403, "only the licensee can download this render");
  return { licenceId: receipt.licenceId, licensee: licence.licensee };
}
