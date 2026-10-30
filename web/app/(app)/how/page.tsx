"use client";

/** How the agents license and pay, in order, and where each piece lives on HSK Chain. */
import { AppPage, Card } from "@/components/ds";
import { useAppState } from "@/components/site/AppState";
import { Addr } from "@/components/ui";

const FLOW = [
  ["Terms on chain", "The creator's price per render, allowed uses, regions, cap and maximum duration live in CreatorRegistry. Political, adult and deceptive uses are banned in the contract."],
  ["A2A request", "The brand's payment agent finds the creator's agent from its A2A card and asks for a licence; the licence is issued on chain within her terms."],
  ["HSP order", "For each render the creator's agent calls HSP's create_order (merchant Likeness), paid to the creator's payout."],
  ["Policy check", "The brand's agent checks the order: the payee is the creator's payout, the price fits her terms and the brand's budget, the licence is active."],
  ["Approval 1, then sign", "prepare_payment returns the authorization to sign. A person approves (recipient, payer, token_total_raw), and the brand wallet signs exactly that EIP-712, unchanged."],
  ["Approval 2, then submit", "finalize_payment returns the payment mandate. A person approves again; submit_payment hands it to HSP, which settles it on HSK Chain."],
  ["Status", "The creator's agent follows query_payment until payment-safe or payment-finalized, with HSP's attribution check."],
  ["Recorded, then the receipt", "HspSettlement records the payment only after it checks the brand's authorization executed on chain; the render agent anchors the file's sha256 in ReceiptAnchor."],
  ["Revoke", "The creator revokes in one click. The brand's agent reads the licence first, so the next payment is refused before any order, signature or payment."],
];

export default function HowPage() {
  const { state } = useAppState();
  const c = state?.contracts;
  return (
    <AppPage title="How it works" description="Agents that pay for consent: A2A for the conversation, HSP for the payment, HSK Chain to enforce the terms.">
      <ol className="m-0 grid list-none grid-cols-1 gap-[14px] p-0 sm:grid-cols-2 lg:grid-cols-3">
        {FLOW.map(([t, b], i) => (
          <li key={t} className="flex flex-col gap-2 rounded-[20px] bg-white p-[18px]">
            <span className="flex h-8 w-8 items-center justify-center rounded-full bg-ink text-[14px] font-semibold text-lime">{i + 1}</span>
            <h2 className="m-0 text-[17px] font-bold">{t}</h2>
            <p className="m-0 text-[14px] text-grey">{b}</p>
          </li>
        ))}
      </ol>

      <Card id="contracts" tone="ink" title="On HSK Chain testnet (chain 133)">
        {c ? (
          <dl className="m-0 grid grid-cols-1 gap-x-4 gap-y-2 text-[14px] sm:grid-cols-[12rem_1fr]">
            <dt className="text-grey-dark">CreatorRegistry</dt>
            <dd className="m-0"><Addr a={c.creators} /></dd>
            <dt className="text-grey-dark">LicenseRegistry</dt>
            <dd className="m-0"><Addr a={c.licences} /></dd>
            <dt className="text-grey-dark">HspSettlement</dt>
            <dd className="m-0"><Addr a={c.settlement} /></dd>
            <dt className="text-grey-dark">ReceiptAnchor</dt>
            <dd className="m-0"><Addr a={c.receipts} /></dd>
            <dt className="text-grey-dark">Token ({state?.token}, testnet)</dt>
            <dd className="m-0"><Addr a={c.token} /></dd>
          </dl>
        ) : (
          <span className="text-grey-dark">Reading…</span>
        )}
        <p className="m-0 text-[13px] text-grey-dark">
          All four contracts are owned by a Safe. The creator agent&apos;s A2A card: <a className="text-lime" href="/.well-known/agent-card.json">/.well-known/agent-card.json</a>. Source and tests:{" "}
          <a className="text-lime" href="https://github.com/rohitshukla11/likeness-hsk">github.com/rohitshukla11/likeness-hsk</a>. The raw console: <a className="text-lime" href="/console">/console</a>.
        </p>
      </Card>
    </AppPage>
  );
}
