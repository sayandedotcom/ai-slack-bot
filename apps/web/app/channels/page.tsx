"use client";

import { ChannelsPanel } from "@/components/dashboard/channels-panel";
import { useIdentityQuery } from "@/lib/hooks/use-dashboard-data";

export default function ChannelsPage() {
  const { identity } = useIdentityQuery();

  return (
    <div className="mx-auto w-full max-w-7xl space-y-6 p-6">
      <ChannelsPanel role={identity?.role ?? null} />
    </div>
  );
}
