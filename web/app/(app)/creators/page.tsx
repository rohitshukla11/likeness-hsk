"use client";

/** Creators: everyone a brand's agent can license on this deployment, Ana Reyes (synthetic) and YouTube-verified creators. */
import { useEffect, useState } from "react";
import { AppPage, Skeleton } from "@/components/ds";
import { CreatorCard } from "@/components/market/CreatorCard";
import { useAppState } from "@/components/site/AppState";
import { api, type CreatorView } from "@/lib/api";
import { categoriesOf, displayOf } from "@/lib/demo";
import { chainLabel, tokenOf } from "@/lib/chain";

export default function CreatorsPage() {
  const { state } = useAppState();
  const [list, setList] = useState<CreatorView[] | null>(null);
  useEffect(() => {
    api<CreatorView[]>("/api/creators").then(setList, () => setList([]));
  }, []);
  return (
    <AppPage title="Creators" description={`Their terms live on ${chainLabel(state?.chainId)}; a brand's agent licenses them from the creator's own agent.`}>
      <div className="grid grid-cols-1 gap-[18px] sm:grid-cols-2 lg:grid-cols-4">
        {list ? (
          // Real creators first, then the synthetic demo creator.
          [...list].sort((a, b) => Number(a.synthetic) - Number(b.synthetic)).map((c) => (
            <CreatorCard key={c.address} c={{ ...displayOf(c), price: `${c.terms.price} ${tokenOf(state)}`, uses: categoriesOf(c.terms.categories), autoApprove: c.terms.autoApprove }} />
          ))
        ) : (
          <Skeleton className="h-[460px]" />
        )}
      </div>
    </AppPage>
  );
}
