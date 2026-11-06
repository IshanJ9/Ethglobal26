"use client";

import { useParams } from "next/navigation";
import { useRequireSession, useSignOutOnUnauthorized } from "@/lib/auth";
import { usePublicConfig } from "@/lib/config";
import { usePayout, useScorecard } from "@/lib/queries";
import { PayoutPanel } from "@/components/scorecard";
import { Card, ErrorNote, Loading, PageTitle, TextLink } from "@/components/ui";

export default function PayoutPage() {
  const { scorecard } = useParams<{ scorecard: string }>();
  const me = useRequireSession();
  const { data: cfg } = usePublicConfig();
  const sc = useScorecard(scorecard);
  const payout = usePayout(scorecard);
  useSignOutOnUnauthorized(payout.error, sc.error);
  if (!me) return null;
  return (
    <div className="flex flex-col gap-6">
      <PageTitle title="Payout" sub={sc.data ? `Scorecard v${sc.data.version}` : undefined} right={<TextLink href={`/scorecards/${scorecard}`}>Open scorecard</TextLink>} />
      <Card>
        {payout.isLoading ? <Loading /> : payout.data ? <PayoutPanel payout={payout.data} chainMode={cfg?.chain_mode ?? "mock"} /> : <ErrorNote error={payout.error} />}
      </Card>
    </div>
  );
}
