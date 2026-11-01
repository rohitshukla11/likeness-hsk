"use client";

/** Moved to the dashboard; old links (with ?licence=) still land there. */
import { useRouter, useSearchParams } from "next/navigation";
import { Suspense, useEffect } from "react";

function Redirect() {
  const router = useRouter();
  const params = useSearchParams();
  useEffect(() => {
    const q = params.toString();
    router.replace(`/dashboard${q ? `?${q}` : ""}`);
  }, [router, params]);
  return null;
}

export default function Moved() {
  return (
    <Suspense>
      <Redirect />
    </Suspense>
  );
}
