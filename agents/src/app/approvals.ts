/**
 * The brand console's approvals for HSP Agentic Payment: the brand agent asks before signing and again
 * before submitting (recipient, payer, token_total_raw), and waits for the person at the console. An
 * approval nobody answers is cancelled when its quote expires, so nothing waits forever and an expired
 * quote is never signed.
 */
import { randomUUID } from "node:crypto";
import type { Approval, Approver } from "../hsp/agentic/payer.js";

export interface PendingApproval extends Approval {
  id: string;
  askedAt: number;
}

export class ApprovalDesk {
  private readonly pending = new Map<string, { a: PendingApproval; resolve: (yes: boolean) => void; timer: ReturnType<typeof setTimeout> }>();

  readonly ask: Approver = (a) =>
    new Promise<boolean>((resolve) => {
      const id = randomUUID();
      const ms = Math.max(0, Date.parse(a.quoteExpiresAt) - Date.now());
      const timer = setTimeout(() => this.decide(id, false), ms);
      this.pending.set(id, { a: { ...a, id, askedAt: Date.now() }, resolve, timer });
    });

  list(): PendingApproval[] {
    return [...this.pending.values()].map((p) => p.a);
  }

  /** The person's answer. False if there is no such pending approval (already answered or expired). */
  decide(id: string, yes: boolean): boolean {
    const p = this.pending.get(id);
    if (!p) return false;
    clearTimeout(p.timer);
    this.pending.delete(id);
    p.resolve(yes);
    return true;
  }
}
