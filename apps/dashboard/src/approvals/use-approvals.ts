/**
 * The approvals state machine. The open-approvals list is a poll, but a
 * decision is a write whose outcome the poll cannot describe: the moment you
 * approve something it leaves the open list, and a list that only ever says
 * "gone" would make every decision — yours, a teammate's, or the agent
 * withdrawing its own ask — look identical and silent.
 *
 * So this hook keeps a small local layer on top of the poll: cards that have
 * been decided stay on screen as a transient note for 15s, then expire. The
 * layer never invents a decision. Only three things can put a card into
 * `resolved`: a 200 that returns what you decided, a 409 that returns who won,
 * or a detail fetch for a card that vanished from the list. Anything else —
 * a network failure, a broken body — puts the card back to `open` with the
 * error on it, because "we don't know" must not render as "done".
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { PanelState } from "../components/panel";
import { usePoll } from "../lib/use-poll";
import {
  type DecideAction,
  type Decision,
  decide,
  fetchApproval,
  fetchOpenApprovals,
  type OpenApproval,
} from "./api";

/** How often the open list is re-read. */
const POLL_MS = 3_000;

/** How long a decided card lingers before it stops being news. */
const RESOLVED_TTL_MS = 15_000;

export type CardState =
  | { kind: "open"; card: OpenApproval; error?: string }
  | { kind: "deciding"; card: OpenApproval; action: DecideAction }
  | {
      kind: "resolved";
      card: OpenApproval;
      decision: Decision;
      decidedBy: string | null;
      mine: boolean;
    };

export function useApprovals(): {
  state: PanelState<CardState[]>;
  decideCard: (id: string, action: DecideAction) => void;
} {
  const poll = usePoll(fetchOpenApprovals, POLL_MS);

  /**
   * Locally-owned card states, keyed by id. Only ids this hook has an opinion
   * about live here; everything else comes straight from the poll.
   */
  const [local, setLocal] = useState<ReadonlyMap<string, CardState>>(
    () => new Map()
  );

  // Mirrors of state and poll data for the async callbacks below, which run
  // long after the closure that started them was created.
  const localRef = useRef(local);
  localRef.current = local;
  const aliveRef = useRef(true);

  /** Last row seen for an id, so a vanished card still has something to draw. */
  const lastRowRef = useRef(new Map<string, OpenApproval>());
  /** Ids present in the previous poll — the only way to notice a disappearance. */
  const previousIdsRef = useRef(new Set<string>());
  /** Ids whose vanish-reconciliation detail fetch has already been started. */
  const reconciledRef = useRef(new Set<string>());
  /** id -> expiry timer, so unmount can cancel every pending removal. */
  const expiryRef = useRef(new Map<string, ReturnType<typeof setTimeout>>());

  useEffect(() => {
    aliveRef.current = true;
    const timers = expiryRef.current;
    return () => {
      aliveRef.current = false;
      for (const timer of timers.values()) clearTimeout(timer);
      timers.clear();
    };
  }, []);

  /** Park a card in `resolved` and start its 15s countdown. */
  const resolveCard = useCallback(
    (
      id: string,
      card: OpenApproval,
      decision: Decision,
      decidedBy: string | null,
      mine: boolean
    ) => {
      if (!aliveRef.current) return;
      setLocal((previous) =>
        new Map(previous).set(id, {
          kind: "resolved",
          card,
          decision,
          decidedBy,
          mine,
        })
      );

      const existing = expiryRef.current.get(id);
      if (existing !== undefined) clearTimeout(existing);
      expiryRef.current.set(
        id,
        setTimeout(() => {
          expiryRef.current.delete(id);
          if (!aliveRef.current) return;
          setLocal((previous) => {
            if (!previous.has(id)) return previous;
            const next = new Map(previous);
            next.delete(id);
            return next;
          });
        }, RESOLVED_TTL_MS)
      );
    },
    []
  );

  const rows = poll.kind === "ready" ? poll.data : null;

  /**
   * Vanish reconciliation. A card that was in the previous poll and is not in
   * this one, with no local decision explaining why, was decided by someone
   * else or withdrawn by the agent. Rather than let it blink out, we ask the
   * detail endpoint what happened to it — that answer is a real source, so it
   * satisfies the "never invent state" rule.
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
      const owned = localRef.current.get(id);
      // A local decision already explains the absence; the poll is the stale
      // one here, not us.
      if (owned !== undefined && owned.kind !== "open") continue;
      // At most one detail fetch per id, ever: without this, every poll that
      // lands while the fetch is in flight would start another one.
      if (reconciledRef.current.has(id)) continue;
      const row = lastRowRef.current.get(id);
      if (row === undefined) continue;
      reconciledRef.current.add(id);

      // Hold the card visible (as the last row the poll gave us) for the round
      // trip, so it does not flicker out and back in.
      setLocal((previous) =>
        previous.has(id)
          ? previous
          : new Map(previous).set(id, { kind: "open", card: row })
      );

      void fetchApproval(id)
        .then((detail) => {
          resolveCard(id, detail, detail.decision, detail.decidedBy, false);
        })
        .catch(() => {
          // We know it left the open list but not why. "withdrawn" with no name
          // is this hook's shape for "resolved elsewhere" — vague, but true.
          resolveCard(id, row, "withdrawn", null, false);
        });
    }
  }, [rows, resolveCard]);

  /**
   * The rendered list. The poll supplies open cards; the local layer overrides
   * it per id, because a decision we just made outranks a list that was read
   * before it landed. The local entry keeps its own `card` — an approval's
   * text is immutable once created, so there is nothing in the polled row
   * worth re-reading.
   */
  const cards = useMemo(() => {
    const merged = new Map<string, CardState>();
    for (const row of rows ?? []) {
      merged.set(row.id, local.get(row.id) ?? { kind: "open", card: row });
    }
    // Deciding and resolved cards that have already left the poll: without
    // this, the transient note would never be seen.
    for (const [id, state] of local) {
      if (!merged.has(id)) merged.set(id, state);
    }
    return [...merged.values()].sort(
      (a, b) => b.card.createdAt - a.card.createdAt
    );
  }, [rows, local]);

  const cardsRef = useRef(cards);
  cardsRef.current = cards;

  const decideCard = useCallback(
    (id: string, action: DecideAction) => {
      const current = cardsRef.current.find((entry) => entry.card.id === id);
      // Anything not `open` is locked: a decision in flight must not be
      // submitted twice, and a resolved card is finished.
      if (current === undefined || current.kind !== "open") return;
      const card = current.card;

      setLocal((previous) =>
        new Map(previous).set(id, { kind: "deciding", card, action })
      );

      void decide(id, action).then((result) => {
        if (!aliveRef.current) return;

        if (result.result === "error") {
          setLocal((previous) =>
            new Map(previous).set(id, {
              kind: "open",
              card,
              error:
                result.error.kind === "unauthorized"
                  ? "Sign in via Access and try again."
                  : result.error.kind === "forbidden"
                    ? "You're not on the roster."
                    : "Could not send that decision. Try again.",
            })
          );
          return;
        }

        if (result.result === "decided") {
          resolveCard(id, card, result.decision, null, true);
          return;
        }

        // Lost the race. The winning DECISION comes from the 409 body and only
        // from there — refetching to learn it would reintroduce the race we
        // just lost. But the worker's conflict body carries no name, and the
        // decider's name exists only on GET /api/approvals/:id, so the two
        // halves of this banner genuinely arrive from two places.
        resolveCard(id, card, result.decision, result.decidedBy, false);

        // Opportunistic, and strictly cosmetic: its only permitted effect is
        // filling in `decidedBy` on a card that is already resolved. It never
        // touches the decision, never moves the card out of `resolved`, and its
        // failure is invisible — the banner simply has no name.
        void fetchApproval(id)
          .then((detail) => {
            if (!aliveRef.current || detail.decidedBy === null) return;
            setLocal((previous) => {
              const entry = previous.get(id);
              if (entry === undefined || entry.kind !== "resolved")
                return previous;
              if (entry.decidedBy !== null) return previous;
              return new Map(previous).set(id, {
                ...entry,
                decidedBy: detail.decidedBy,
              });
            });
          })
          .catch(() => {});
      });
    },
    [resolveCard]
  );

  const state: PanelState<CardState[]> =
    cards.length > 0
      ? { kind: "ready", data: cards }
      : poll.kind === "loading"
        ? { kind: "loading" }
        : poll.kind === "error"
          ? { kind: "error", error: poll.error, retry: poll.retry }
          : // The same reassurance the panel renders for a ready-empty list. An
            // empty queue is the normal state, so the hint names the agent's
            // escalation rule rather than reading as an absence of work.
            {
              kind: "empty",
              hint: "Nothing needs a decision. The agent escalates only committal replies.",
            };

  return { state, decideCard };
}
