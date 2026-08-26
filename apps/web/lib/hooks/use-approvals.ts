"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useCallback, useEffect, useMemo, useRef } from "react";

import {
  decide,
  getApproval,
  getOpenApprovals,
  type DecideAction,
  type OpenApproval,
} from "../api/approvals";
import type { PanelState } from "../panel-state";
import { POLL_MS, queryKeys } from "../query/keys";
import { toPanelState } from "../query/to-panel-state";
import { useApprovalsOverlay, type CardState } from "../store/approvals-overlay";

export type { CardState };

export const EMPTY_QUEUE_HINT =
  "Nothing needs a decision. The agent escalates only committal replies.";

/** One human sentence per failure kind. The card shows this, never a status number. */
const DECIDE_ERROR = {
  unauthorized: "Sign in via Access and try again.",
  forbidden: "You're not on the roster.",
  unavailable: "Could not send that decision. Try again.",
} as const;

/**
 * The open queue: a cached poll for the rows, a mutation for the decision, and
 * the Zustand overlay for everything the poll cannot express.
 *
 * The split matters. TanStack owns the SERVER's answer and nothing else;
 * the overlay owns what this browser did about it. Merging them here — rather
 * than writing decisions into the query cache — keeps the rule that a decision
 * is never invented visible in one place, and keeps a background refetch from
 * silently overwriting a decision that is still in flight.
 */
export function useApprovals(): {
  state: PanelState<CardState[]>;
  openCount: number;
  decideCard: (id: string, action: DecideAction) => void;
} {
  const queryClient = useQueryClient();
  const query = useQuery({
    queryKey: queryKeys.openApprovals,
    queryFn: getOpenApprovals,
    refetchInterval: POLL_MS.approvals,
  });

  const overlay = useApprovalsOverlay((s) => s.cards);
  const { beginDecide, failDecide, resolve, hold, nameDecider, claimReconcile } =
    useApprovalsOverlay.getState();

  const rows = query.data ?? null;

  /** Last row seen for an id, so a vanished card still has something to draw. */
  const lastRowRef = useRef(new Map<string, OpenApproval>());
  /** Ids present in the previous poll — the only way to notice a disappearance. */
  const previousIdsRef = useRef(new Set<string>());

  /**
   * Vanish reconciliation. A card that was in the previous poll and is not in
   * this one, with no local decision explaining why, was decided by someone
   * else or withdrawn by the agent. Rather than let it blink out, ask the
   * detail endpoint what happened — that answer is a real source, so it obeys
   * the never-invent rule.
   */
  useEffect(() => {
    if (rows === null) return;

    const ids = new Set<string>();
    for (const row of rows) {
      ids.add(row.id);
      lastRowRef.current.set(row.id, row);
    }
    const previousIds = previousIdsRef.current;
    previousIdsRef.current = ids;

    for (const id of previousIds) {
      if (ids.has(id)) continue;
      const owned = useApprovalsOverlay.getState().cards.get(id);
      // A local decision already explains the absence; the poll is the stale one.
      if (owned !== undefined && owned.kind !== "open") continue;
      const row = lastRowRef.current.get(id);
      if (row === undefined) continue;
      // At most one detail read per id, ever.
      if (!claimReconcile(id)) continue;

      // Hold it visible for the round trip so it does not flicker out and back in.
      hold(row);

      void queryClient
        .fetchQuery({ queryKey: queryKeys.approval(id), queryFn: () => getApproval(id) })
        .then((detail) => resolve(detail, detail.decision, detail.decidedBy, false))
        .catch(() => {
          // We know it left the open list but not why. "withdrawn" with no name
          // is this store's shape for "resolved elsewhere" — vague, but true.
          resolve(row, "withdrawn", null, false);
        });
    }
  }, [rows, claimReconcile, hold, resolve, queryClient]);

  const mutation = useMutation({
    mutationFn: ({ card, action }: { card: OpenApproval; action: DecideAction }) =>
      decide(card.id, action).then((result) => ({ card, result })),
    onMutate: ({ card, action }) => {
      beginDecide(card, action);
    },
    onSuccess: ({ card, result }) => {
      if (result.result === "error") {
        failDecide(card, DECIDE_ERROR[result.error.kind]);
        return;
      }

      if (result.result === "decided") {
        resolve(card, result.decision, null, true);
        // The row is gone server-side; stop showing a stale open list until the
        // next tick of the interval would have noticed.
        void queryClient.invalidateQueries({ queryKey: queryKeys.openApprovals });
        return;
      }

      // Lost the race. The winning DECISION comes from the 409 body and only
      // from there — refetching to learn it would reintroduce the race we just
      // lost. But the worker's conflict body carries no name, and the decider's
      // name exists only on GET /api/approvals/:id, so the two halves of this
      // banner genuinely arrive from two places.
      resolve(card, result.decision, result.decidedBy, false);
      void queryClient.invalidateQueries({ queryKey: queryKeys.openApprovals });

      // Opportunistic and strictly cosmetic: its only permitted effect is
      // filling in a name on a card that is already resolved. Failure is
      // invisible — the banner simply has no name.
      void queryClient
        .fetchQuery({
          queryKey: queryKeys.approval(card.id),
          queryFn: () => getApproval(card.id),
        })
        .then((detail) => {
          if (detail.decidedBy !== null) nameDecider(card.id, detail.decidedBy);
        })
        .catch(() => {});
    },
    onError: (_error, { card }) => {
      // `decide` resolves rather than throws for every outcome it understands,
      // so reaching here means the transport itself broke.
      failDecide(card, DECIDE_ERROR.unavailable);
    },
  });

  /**
   * The rendered list. The poll supplies open cards; the overlay overrides it
   * per id, because a decision just made outranks a list read before it landed.
   * The overlay entry keeps its own `card` — an approval's text is immutable
   * once created, so there is nothing in the polled row worth re-reading.
   */
  const cards = useMemo(() => {
    const merged = new Map<string, CardState>();
    for (const row of rows ?? []) {
      merged.set(row.id, overlay.get(row.id) ?? { kind: "open", card: row });
    }
    // Deciding and resolved cards that have already left the poll: without
    // this, the transient note would never be seen.
    for (const [id, state] of overlay) {
      if (!merged.has(id)) merged.set(id, state);
    }
    return [...merged.values()].sort((a, b) => b.card.createdAt - a.card.createdAt);
  }, [rows, overlay]);

  /**
   * `cards` is a dependency rather than a ref read during render. Writing a ref
   * in the render body is the shape that makes a component miss an update, and
   * there is nothing to gain from it here: this callback is handed to a button,
   * so a fresh identity per render costs nothing.
   */
  const decideCard = useCallback(
    (id: string, action: DecideAction) => {
      const current = cards.find((entry) => entry.card.id === id);
      // Anything not `open` is locked: a decision in flight must not be
      // submitted twice, and a resolved card is finished.
      if (current === undefined || current.kind !== "open") return;
      mutation.mutate({ card: current.card, action });
    },
    [cards, mutation],
  );

  /**
   * The queue's state is the ROWS' state everywhere except `ready`: a loading
   * or unreachable list is a loading or unreachable queue. Only when the rows
   * did arrive does the overlay get to decide, because a queue that is empty
   * on the server can still have a decided card lingering on screen.
   */
  const rowsState = toPanelState(query);
  const state: PanelState<CardState[]> =
    cards.length > 0
      ? { kind: "ready", data: cards }
      : rowsState.kind === "error"
        ? { kind: "error", error: rowsState.error, retry: rowsState.retry }
        : rowsState.kind === "loading"
          ? { kind: "loading" }
          : { kind: "empty", hint: EMPTY_QUEUE_HINT };

  // The header badge counts what is still WAITING, not what is on screen — a
  // card lingering as a resolved note is news, not work.
  const openCount = cards.filter((entry) => entry.kind === "open").length;

  return { state, openCount, decideCard };
}
