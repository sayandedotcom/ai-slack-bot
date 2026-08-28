"use client";

import { SectionHeader } from "@/components/common/section-header";
import { ApprovalsQueue } from "@/components/dashboard/approvals-queue";
import { DecidedList } from "@/components/dashboard/decided-list";
import { useIdentityQuery } from "@/lib/hooks/use-dashboard-data";

export default function ApprovalsPage() {
  const { identity } = useIdentityQuery();

  return (
    <div className="mx-auto w-full max-w-7xl space-y-6 p-6">
      <SectionHeader
        eyebrow="Waiting on you"
        title="Approve what the agent may send"
        description="Approving sends the reply to Slack under a fire-fighter's own account."
      />
      <ApprovalsQueue role={identity?.role ?? "viewer"} />
      <DecidedList />
    </div>
  );
}
