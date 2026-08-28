"use client";

import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@workspace/ui/components/select";
import {
  Tabs,
  TabsContent,
  TabsList,
  TabsTrigger,
} from "@workspace/ui/components/tabs";
import { useState } from "react";

import { Panel } from "@/components/common/panel";
import { SectionHeader } from "@/components/common/section-header";
import { ShadowPanel } from "@/components/dashboard/shadow-panel";
import { TriageScoreView } from "@/components/eval/triage-score";
import type { TriageDays } from "@/lib/api/eval";
import { useTriageScore } from "@/lib/hooks/use-dashboard-data";

const DAY_OPTIONS: { value: string; label: string }[] = [
  { value: "7", label: "7 days" },
  { value: "30", label: "30 days" },
  { value: "90", label: "90 days" },
];

export default function EvalPage() {
  const [days, setDays] = useState<TriageDays>(30);
  const triage = useTriageScore(days);

  return (
    <div className="mx-auto w-full max-w-7xl space-y-6 p-6">
      <SectionHeader
        eyebrow="Eval"
        title="How the agent is doing"
        description="What it would have said next to what a human actually sent, and how often triage agreed with a human's own decision to answer."
      />

      <Tabs defaultValue="shadow">
        <TabsList>
          <TabsTrigger value="shadow">Shadow</TabsTrigger>
          <TabsTrigger value="triage">Triage</TabsTrigger>
        </TabsList>

        <TabsContent value="shadow" className="pt-4">
          <ShadowPanel />
        </TabsContent>

        <TabsContent value="triage" className="space-y-4 pt-4">
          <div className="flex justify-end">
            <Select
              value={String(days)}
              onValueChange={(value) => setDays(Number(value) as TriageDays)}
            >
              <SelectTrigger size="sm" aria-label="Window">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {DAY_OPTIONS.map((opt) => (
                  <SelectItem key={opt.value} value={opt.value}>
                    {opt.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>

          <Panel title="Triage" state={triage} bare>
            {(report) => <TriageScoreView report={report} />}
          </Panel>
        </TabsContent>
      </Tabs>
    </div>
  );
}
