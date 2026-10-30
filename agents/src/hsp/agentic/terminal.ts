/**
 * The guide's two confirmations in a terminal (pnpm run testnet): the recipient, the payer and
 * token_total_raw are shown, and only a typed "yes" approves. With no terminal attached, or when the
 * quote expires before an answer, the answer is no: a script never approves on anyone's behalf.
 */
import { createInterface } from "node:readline/promises";
import type { Approval, Approver } from "./payer.js";

const readable = (raw: string, decimals: number) => {
  const v = BigInt(raw);
  const p = 10n ** BigInt(decimals);
  return `${v / p}.${(v % p).toString().padStart(decimals, "0")}`;
};

export function describeApproval(a: Approval): string {
  return [
    a.stage === "sign" ? "Approve SIGNING this payment authorization?" : "Approve SUBMITTING the signed payment?",
    `  recipient (pay_to): ${a.payTo}`,
    `  payer:              ${a.payer}`,
    `  token_total_raw:    ${a.tokenTotalRaw} raw units (≈ ${readable(a.tokenTotalRaw, a.token.decimals)} ${a.token.symbol}, ${a.token.decimals} decimals)`,
    `  token:              ${a.token.address}`,
    `  network fee:        ${a.gasFeeAdvanced === true ? "advanced by the platform, not in the total" : a.gasFeeAdvanced === false ? "included in the total" : "not stated"}`,
    `  quote expires:      ${a.quoteExpiresAt}`,
    `  flow_id ${a.flowId} · payment_request_id ${a.paymentRequestId}`,
  ].join("\n");
}

export function terminalApprover(io: { input: NodeJS.ReadableStream; output: NodeJS.WritableStream; interactive: boolean } = { input: process.stdin, output: process.stdout, interactive: !!process.stdin.isTTY }): Approver {
  return async (a) => {
    io.output.write(`\n${describeApproval(a)}\n`);
    if (!io.interactive) {
      io.output.write("  no terminal to answer: not approved\n");
      return false;
    }
    const rl = createInterface({ input: io.input, output: io.output });
    const ms = Math.max(0, Date.parse(a.quoteExpiresAt) - Date.now());
    const timeout = new AbortController();
    const timer = setTimeout(() => timeout.abort(), ms);
    try {
      const answer = await rl.question('  type "yes" to approve, anything else cancels: ', { signal: timeout.signal });
      return answer.trim().toLowerCase() === "yes";
    } catch {
      io.output.write("\n  the quote expired before an answer: not approved\n");
      return false;
    } finally {
      clearTimeout(timer);
      rl.close();
    }
  };
}
