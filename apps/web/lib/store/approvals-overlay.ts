import { create } from "zustand";

import type { DecideAction, Decision, OpenApproval } from "../api/approvals";

/**
 * The one piece of genuine client state in this app, and the reason Zustand is
 * here rather than a `useState` in the queue component.
 *
 * The open-approvals list is a poll, but a decision is a write whose outcome
 * the poll cannot describe: the moment you approve something it leaves the open
 * list, and a list that only ever says "gone" would make every decision —
 * yours, a teammate's, or the agent withdrawing its own ask — look identical
 * and silent. So a decided card stays on screen as a transient note, then
 * expires.
 *
 * That overlay is read in two places (the queue, and the sidebar badge that
 * counts what is still waiting), it outlives any one component's mount, and it
 * owns timers. A store makes all three honest, and makes the state machine
 * testable without rendering anything.
 *
 * The one rule this file must never break: it NEVER invents a decision. Only
 * two things can move a card to `resolved` — a 200 returning what you decided,
 * or a 409 returning who won and their name, directly in the body. A network
 * failure puts the card back to `open` with an error on it, because "we don't
 * know" must not render as "done". A card that vanishes from the open poll
 * with no local decision explaining it (decided elsewhere, or withdrawn) is
 * NOT reconciled here any more — it simply leaves the open list, and the
 * honest place to see it is the Decided list (`useDecidedApprovals`), which
 * reads a real source instead of this store inventing one.
 */

/** How long a decided card lingers before it stops being news. */
export const RESOLVED_TTL_MS = 15_000;

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

type ApprovalsOverlay = {
  /** Only ids this store has an opinion about. Everything else comes from the poll. */
  cards: ReadonlyMap<string, CardState>;

  /** Move a card into `deciding`, locking its controls against a double submit. */
  beginDecide: (card: OpenApproval, action: DecideAction) => void;
  /** A decision that did not land. Back to `open`, carrying a human sentence. */
  failDecide: (card: OpenApproval, message: string) => void;
  /** Park a card in `resolved` and start its expiry. */
  resolve: (
    card: OpenApproval,
    decision: Decision,
    decidedBy: string | null,
    mine: boolean
  ) => void;
  forget: (id: string) => void;
  /** Cancel every pending expiry. For tests and for a full teardown. */
  reset: () => void;
};

/**
 * Expiry timers live beside the store, not inside its state: they are not
 * rendered, and putting them in state would make every tick a re-render.
 */
const timers = new Map<string, ReturnType<typeof setTimeout>>();

function withCard(
  cards: ReadonlyMap<string, CardState>,
  id: string,
  state: CardState
): ReadonlyMap<string, CardState> {
  return new Map(cards).set(id, state);
}

export const useApprovalsOverlay = create<ApprovalsOverlay>()((set, get) => ({
  cards: new Map(),

  beginDecide: (card, action) =>
    set((s) => ({
      cards: withCard(s.cards, card.id, { kind: "deciding", card, action }),
    })),

  failDecide: (card, message) =>
    set((s) => ({
      cards: withCard(s.cards, card.id, { kind: "open", card, error: message }),
    })),

  resolve: (card, decision, decidedBy, mine) => {
    set((s) => ({
      cards: withCard(s.cards, card.id, {
        kind: "resolved",
        card,
        decision,
        decidedBy,
        mine,
      }),
    }));

    const existing = timers.get(card.id);
    if (existing !== undefined) clearTimeout(existing);
    timers.set(
      card.id,
      setTimeout(() => {
        timers.delete(card.id);
        get().forget(card.id);
      }, RESOLVED_TTL_MS)
    );
  },

  forget: (id) =>
    set((s) => {
      if (!s.cards.has(id)) return s;
      const next = new Map(s.cards);
      next.delete(id);
      return { cards: next };
    }),

  reset: () => {
    for (const timer of timers.values()) clearTimeout(timer);
    timers.clear();
    set({ cards: new Map() });
  },
}));
