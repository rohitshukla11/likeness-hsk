"use client";

/** Creators: everyone a brand's agent can license on this deployment (one demo creator). */
import { AppPage, Skeleton } from "@/components/ds";
import { CreatorCard } from "@/components/market/CreatorCard";
import { useAppState } from "@/components/site/AppState";
import { categoriesOf, DEMO_CREATOR } from "@/lib/demo";

export default function CreatorsPage() {
  const { state } = useAppState();
  return (
    <AppPage title="Creators" description="Their terms live on HSK Chain; a brand's agent licenses them from the creator's own agent.">
      <div className="grid grid-cols-1 gap-[18px] sm:grid-cols-2 lg:grid-cols-4">
        {state ? (
          <CreatorCard
            c={{ ...DEMO_CREATOR, price: `${state.terms.price} ${state.token}`, uses: categoriesOf(state.terms.categories), autoApprove: state.terms.autoApprove }}
          />
        ) : (
          <Skeleton className="h-[460px]" />
        )}
      </div>
    </AppPage>
  );
}
