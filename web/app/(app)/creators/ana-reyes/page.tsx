"use client";

/** Ana Reyes, the synthetic demo creator: her profile and the licence request (not listed on the public server). */
import Link from "next/link";
import { AppPage, btnClass } from "@/components/ds";
import { CreatorProfile } from "@/components/market/CreatorProfile";
import { useAppState } from "@/components/site/AppState";

export default function AnaReyes() {
  const { state } = useAppState();
  if (state && state.demoCreator === false)
    return (
      <AppPage title="Creator not found" description="This creator isn't listed on this server.">
        <Link href="/creators" className={btnClass("ink", "self-start")}>
          See the creators
        </Link>
      </AppPage>
    );
  return <CreatorProfile address={state?.creator} />;
}
