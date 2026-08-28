import { demoEffectsFor } from "../fixtures/effects";
import { fixture, getJson, isDemo } from "./client";

export type EffectState = "reserved" | "completed" | "failed" | "in_doubt";

/** One row of the effect ledger, as `GET /api/runs/:id/effects` returns it. Never carries arguments. */
export type RunEffect = {
  turnId: string;
  namespace: string;
  method: string;
  state: EffectState;
  safeResult: unknown;
  safeError: string | null;
  createdAt: number;
};

export async function getRunEffects(runId: string): Promise<RunEffect[]> {
  if (isDemo()) return fixture(demoEffectsFor(runId));
  const body = await getJson<{ effects: RunEffect[] }>(
    `/api/runs/${encodeURIComponent(runId)}/effects`
  );
  return body.effects;
}

const URL_KEYS = ["url", "html_url", "permalink"] as const;

/** A link the effect produced, or null. Only https — a result is data, not a place to put a scheme. */
export function effectUrl(effect: RunEffect): string | null {
  const r = effect.safeResult;
  if (typeof r !== "object" || r === null) return null;
  for (const key of URL_KEYS) {
    const value = (r as Record<string, unknown>)[key];
    if (typeof value === "string" && value.startsWith("https://")) return value;
  }
  return null;
}

/** "namespace.method", repeats folded into "×N", in first-seen order per turn. */
export function chipsByTurn(
  effects: readonly RunEffect[]
): Map<string, string[]> {
  const perTurn = new Map<string, Map<string, number>>();
  // `GET /runs/:id/effects` returns the ledger newest-first, but a chip strip
  // reads left-to-right as "what happened, in order" — so this sorts ascending
  // by `createdAt` rather than blindly reversing the array. A stable sort
  // (`Array#sort` is stable) also means ties keep whatever relative order the
  // caller handed in, rather than a reversal silently flipping them too.
  const oldestFirst = [...effects].sort((a, b) => a.createdAt - b.createdAt);
  for (const e of oldestFirst) {
    const counts = perTurn.get(e.turnId) ?? new Map<string, number>();
    const name = `${e.namespace}.${e.method}`;
    counts.set(name, (counts.get(name) ?? 0) + 1);
    perTurn.set(e.turnId, counts);
  }
  const out = new Map<string, string[]>();
  for (const [turn, counts] of perTurn) {
    out.set(
      turn,
      [...counts].map(([name, n]) => (n > 1 ? `${name} ×${n}` : name))
    );
  }
  return out;
}
