"use client";

import { Input } from "@workspace/ui/components/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@workspace/ui/components/select";
import { useState } from "react";

import { SectionHeader } from "@/components/common/section-header";
import { ChannelsPanel } from "@/components/dashboard/channels-panel";
import type { ChannelMode } from "@/lib/api/channels";
import { useIdentityQuery } from "@/lib/hooks/use-dashboard-data";

const MODE_OPTIONS: { value: ChannelMode | "any"; label: string }[] = [
  { value: "any", label: "Any" },
  { value: "observe", label: "observe" },
  { value: "live", label: "live" },
  { value: "internal", label: "internal" },
];

export default function ChannelsPage() {
  const { identity } = useIdentityQuery();
  const [query, setQuery] = useState("");
  const [mode, setMode] = useState<ChannelMode | "any">("any");

  return (
    <div className="mx-auto w-full max-w-7xl space-y-6 p-6">
      <SectionHeader
        eyebrow="Registry"
        title="Channels"
        description="New channels register themselves on their first message and default to live. A human decides mode and customer key; nothing here is ever deleted."
      />

      <div className="flex flex-wrap items-center gap-2">
        <Input
          aria-label="Search channels"
          placeholder="Search channels…"
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          className="min-w-40 flex-1"
        />

        <Select
          value={mode}
          onValueChange={(value) => setMode(value as ChannelMode | "any")}
        >
          <SelectTrigger size="sm" aria-label="Filter by mode">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {MODE_OPTIONS.map((opt) => (
              <SelectItem key={opt.value} value={opt.value}>
                {opt.label}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>

      <ChannelsPanel
        role={identity?.role ?? null}
        query={query}
        mode={mode === "any" ? null : mode}
      />
    </div>
  );
}
