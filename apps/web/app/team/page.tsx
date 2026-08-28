"use client";

import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@workspace/ui/components/collapsible";
import { ChevronRight } from "lucide-react";
import { useState } from "react";

import { SectionHeader } from "@/components/common/section-header";
import { NudgePreview } from "@/components/dashboard/nudge-preview";
import { RefusalBanner } from "@/components/dashboard/speaker-hero";
import { TeamTable } from "@/components/dashboard/team-table";
import { TokenExplainer } from "@/components/dashboard/token-explainer";
import { useIdentityQuery, useRoster } from "@/lib/hooks/use-dashboard-data";

export default function TeamPage() {
  const roster = useRoster();
  const { identity } = useIdentityQuery();
  const [howOpen, setHowOpen] = useState(false);

  return (
    <div className="mx-auto w-full max-w-7xl space-y-6 p-6">
      <SectionHeader eyebrow="Roster" title="Who the agent speaks as" />

      <RefusalBanner state={roster} />

      <TeamTable
        state={roster}
        identity={identity}
        speaker={
          roster.kind === "ready" ? (roster.data.speaker?.email ?? null) : null
        }
      />

      <Collapsible open={howOpen} onOpenChange={setHowOpen}>
        <CollapsibleTrigger className="flex items-center gap-2 text-sm">
          <ChevronRight
            className={
              howOpen
                ? "size-4 rotate-90 transition-transform"
                : "size-4 transition-transform"
            }
          />
          <span className="eyebrow">How this works</span>
        </CollapsibleTrigger>
        <CollapsibleContent className="pt-3">
          <div className="grid gap-4 lg:grid-cols-2">
            <TokenExplainer />
            <NudgePreview />
          </div>
        </CollapsibleContent>
      </Collapsible>
    </div>
  );
}
