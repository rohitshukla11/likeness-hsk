"use client";

/**
 * The one dashboard, by who is signed in: a new Google account chooses Brand or Creator; a brand gets the
 * brand console; a creator gets onboarding until registered, then their own licences, payments and
 * revoke. The admin session (demo password) gets the brand console and Ana Reyes's dashboard.
 */
import Link from "next/link";
import { AppPage, btnClass, Card } from "@/components/ds";
import { BrandConsole } from "@/components/dashboard/BrandConsole";
import { CreatorDashboard } from "@/components/dashboard/CreatorDashboard";
import { ChooseRole, CreatorOnboarding } from "@/components/dashboard/Onboarding";
import { useAppState } from "@/components/site/AppState";
import { useAuth } from "@/components/site/Auth";
import { SignIn } from "@/components/site/SignIn";

export default function DashboardPage() {
  const { state } = useAppState();
  const { user, me, refreshMe } = useAuth();
  const role = me?.account?.role;

  if (user === undefined || (user && !me)) return <AppPage title="Dashboard">{null}</AppPage>;

  if (!user) {
    if (state?.operator)
      return (
        <>
          <BrandConsole />
          <CreatorDashboard />
        </>
      );
    return (
      <AppPage title="Dashboard" description="Brands and creators sign in with Google.">
        <Card>
          <p className="m-0 text-[14px] text-grey">Sign in to license a creator as a brand, or to put your own face on Likeness as a YouTube-verified creator.</p>
          <div>
            <SignIn light />
          </div>
        </Card>
      </AppPage>
    );
  }

  if (!role)
    return (
      <AppPage title="Dashboard" description={`${me!.account!.name} · ${me!.account!.email}`}>
        <ChooseRole onDone={refreshMe} />
      </AppPage>
    );

  if (role === "brand") return <BrandConsole />;

  if (!me?.creator?.registeredTx)
    return (
      <AppPage title="Become a creator" description={`${me!.account!.name} · ${me!.account!.email}`}>
        <CreatorOnboarding me={me!} onChange={refreshMe} />
      </AppPage>
    );

  return (
    <>
      <CreatorDashboard />
      <div className="mx-auto w-full max-w-[1320px] px-4 pb-10 sm:px-8">
        <Link href={`/creators/${me.creator.address.toLowerCase()}`} className={btnClass("outline")}>
          Your public profile
        </Link>
      </div>
    </>
  );
}
