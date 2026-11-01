"use client";

/** A registered creator's profile, by their creator wallet address. */
import { useParams } from "next/navigation";
import { CreatorProfile } from "@/components/market/CreatorProfile";

export default function CreatorById() {
  const { id } = useParams<{ id: string }>();
  return <CreatorProfile address={/^0x[0-9a-fA-F]{40}$/.test(id) ? id : undefined} />;
}
