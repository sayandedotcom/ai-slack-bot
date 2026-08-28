"use client";

import { Button } from "@workspace/ui/components/button";
import { Input } from "@workspace/ui/components/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@workspace/ui/components/select";
import { cn } from "@workspace/ui/lib/utils";
import { X } from "lucide-react";
import { useEffect, useRef, useState } from "react";

import type { RunStatus } from "@/lib/api/runs";
import {
  activeFilterCount,
  EMPTY_FILTERS,
  type RunFilters,
  withFilter,
} from "@/lib/runs/filters";

const SEARCH_DEBOUNCE_MS = 250;

const STATUS_OPTIONS: { value: RunStatus | "all"; label: string }[] = [
  { value: "all", label: "All" },
  { value: "live", label: "Live" },
  { value: "awaiting_approval", label: "Needs you" },
  { value: "idle", label: "Idle" },
  { value: "done", label: "Done" },
  { value: "failed", label: "Failed" },
];

const ORIGIN_OPTIONS: { value: "any" | "slack" | "chat"; label: string }[] = [
  { value: "any", label: "Any" },
  { value: "slack", label: "Slack" },
  { value: "chat", label: "Chat" },
];

const SHADOW_OPTIONS: { value: "any" | "only" | "hide"; label: string }[] = [
  { value: "any", label: "Any" },
  { value: "only", label: "Shadow only" },
  { value: "hide", label: "Hide shadow" },
];

function shadowValue(shadow: boolean | null): "any" | "only" | "hide" {
  return shadow === null ? "any" : shadow ? "only" : "hide";
}

/**
 * Search input + chips over `RunFilters`. Every control writes through
 * `withFilter`, so a component here never has to know how the filter shape is
 * combined with the others.
 */
export function RunFilterBar({
  filters,
  onChange,
  channels,
}: {
  filters: RunFilters;
  onChange: (f: RunFilters) => void;
  channels: { channelId: string; name: string }[];
}) {
  // The search box keeps its own draft so every keystroke does not itself
  // trigger a request — `onChange` (and therefore the URL and the query) only
  // moves 250ms after the last keystroke. `filters`/`onChange` are read
  // through refs so retyping doesn't restart the timer and an identity change
  // on either (e.g. because the debounce itself just fired `onChange`) can't
  // create a dependency loop.
  const [draft, setDraft] = useState(filters.q);
  useEffect(() => {
    setDraft(filters.q);
  }, [filters.q]);

  const filtersRef = useRef(filters);
  filtersRef.current = filters;
  const onChangeRef = useRef(onChange);
  onChangeRef.current = onChange;
  const timerRef = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);

  useEffect(() => () => clearTimeout(timerRef.current), []);

  const handleSearchChange = (value: string) => {
    setDraft(value);
    clearTimeout(timerRef.current);
    timerRef.current = setTimeout(() => {
      onChangeRef.current(withFilter(filtersRef.current, "q", value));
    }, SEARCH_DEBOUNCE_MS);
  };

  const showClear = activeFilterCount(filters) > 0 || filters.q !== "";

  return (
    <div className="flex flex-wrap items-center gap-2">
      <Input
        aria-label="Search runs"
        placeholder="Search runs…"
        value={draft}
        onChange={(event) => handleSearchChange(event.target.value)}
        className="min-w-40 flex-1"
      />

      <Select
        value={filters.status ?? "all"}
        onValueChange={(value) =>
          onChange(
            withFilter(
              filters,
              "status",
              value === "all" ? null : (value as RunStatus)
            )
          )
        }
      >
        <SelectTrigger size="sm" aria-label="Filter by status">
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          {STATUS_OPTIONS.map((opt) => (
            <SelectItem key={opt.value} value={opt.value}>
              {opt.label}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>

      <Select
        value={filters.origin ?? "any"}
        onValueChange={(value) =>
          onChange(
            withFilter(
              filters,
              "origin",
              value === "any" ? null : (value as "slack" | "chat")
            )
          )
        }
      >
        <SelectTrigger size="sm" aria-label="Filter by origin">
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          {ORIGIN_OPTIONS.map((opt) => (
            <SelectItem key={opt.value} value={opt.value}>
              {opt.label}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>

      <Select
        value={filters.channelId ?? "any"}
        onValueChange={(value) =>
          onChange(
            withFilter(filters, "channelId", value === "any" ? null : value)
          )
        }
      >
        <SelectTrigger size="sm" aria-label="Filter by channel">
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          <SelectItem value="any">Any channel</SelectItem>
          {channels.map((channel) => (
            <SelectItem key={channel.channelId} value={channel.channelId}>
              #{channel.name}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>

      <fieldset
        className="m-0 flex items-center gap-0.5 rounded-md border p-0.5"
        aria-label="Filter by shadow"
      >
        {SHADOW_OPTIONS.map((opt) => {
          const active = shadowValue(filters.shadow) === opt.value;
          return (
            <Button
              key={opt.value}
              type="button"
              variant="ghost"
              size="xs"
              aria-pressed={active}
              className={cn(active && "bg-muted text-foreground")}
              onClick={() =>
                onChange(
                  withFilter(
                    filters,
                    "shadow",
                    opt.value === "any" ? null : opt.value === "only"
                  )
                )
              }
            >
              {opt.label}
            </Button>
          );
        })}
      </fieldset>

      {showClear ? (
        <Button
          type="button"
          variant="ghost"
          size="sm"
          onClick={() => onChange(EMPTY_FILTERS)}
        >
          <X /> Clear
        </Button>
      ) : null}
    </div>
  );
}
