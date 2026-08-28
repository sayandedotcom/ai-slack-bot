"use client";

import { ApprovalsQueue } from "@/components/dashboard/approvals-queue";
import { useIdentityQuery } from "@/lib/hooks/use-dashboard-data";

export default function ApprovalsPage() {
  const { identity } = useIdentityQuery();

  return (
    <div className="mx-auto w-full max-w-7xl space-y-6 p-6">
      <ApprovalsQueue role={identity?.role ?? "viewer"} />
    </div>
  );
}
