"use client";

import { SpeakerHero } from "@/components/dashboard/speaker-hero";
import { TeamTable } from "@/components/dashboard/team-table";
import { useIdentityQuery, useRoster } from "@/lib/hooks/use-dashboard-data";

export default function TeamPage() {
  const roster = useRoster();
  const { identity } = useIdentityQuery();

  return (
    <div className="mx-auto w-full max-w-7xl space-y-6 p-6">
      <SpeakerHero state={roster} />
      <TeamTable state={roster} identity={identity} />
    </div>
  );
}
