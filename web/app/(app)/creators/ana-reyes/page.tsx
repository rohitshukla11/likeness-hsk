"use client";

/** Ana Reyes, the synthetic demo creator: her profile and the licence request. */
import { CreatorProfile } from "@/components/market/CreatorProfile";
import { useAppState } from "@/components/site/AppState";

export default function AnaReyes() {
  const { state } = useAppState();
  return <CreatorProfile address={state?.creator} />;
}
