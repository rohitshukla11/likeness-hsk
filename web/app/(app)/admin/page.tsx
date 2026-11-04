"use client";

/** The admin fallback: the demo password opens an operator session (acts for the shared brand agent and Ana Reyes). */
import { DemoPrep } from "@/components/admin/DemoPrep";
import { LiveQaPayment } from "@/components/admin/LiveQaPayment";
import { AppPage, Card } from "@/components/ds";
import { useAppState } from "@/components/site/AppState";
import { OperatorGate } from "@/components/site/OperatorGate";

export default function AdminPage() {
  const { state, refresh } = useAppState();
  return (
    <AppPage title="Admin" description="For the team only. Brands and creators sign in with Google instead.">
      <Card tone="ink" title={state?.operator ? "Admin session is on" : "Demo password"}>
        <p className="m-0 text-[14px] text-grey-dark">
          The admin session acts for the shared demo brand agent{state?.demoCreator === false ? "" : " and for Ana Reyes (the synthetic creator)"}, without a Google account. It ends
          after 12 hours or when the server restarts.
        </p>
        <OperatorGate state={state} onChange={() => void refresh()} />
      </Card>
      {state?.operator && <DemoPrep />}
      {state?.operator && <LiveQaPayment />}
    </AppPage>
  );
}
