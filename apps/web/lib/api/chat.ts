import { fixture, isDemo } from "./client";
import { demoChatThread } from "../fixtures/chat";

/**
 * The chat surface's shape.
 *
 * There is NO live transport behind this module, and that is not an oversight
 * of this app. The agent layer was removed from the Worker (commit 2698e88,
 * "feat!: remove the agent layer, to be rebuilt on the Agents SDK"); as of
 * today `apps/worker/src` mounts no `/agents/*`, no `/ws/run/:id` and no chat
 * route. `getChatThread` therefore refuses rather than inventing an endpoint —
 * see BACKEND-GAPS.md §2 for the contract it would need.
 */

export type Citation = {
  channelName: string;
  day: string;
  quote: string;
  outcome: string;
  permalink: string | null;
};

export type ToolCall = {
  /** Namespaced capability, e.g. `linear.create` — rendered in mono. */
  name: string;
  detail: string;
};

export type ChatMessage = {
  id: string;
  author: "user" | "agent";
  /** Display name; for the agent this is always "Firefighter". */
  name: string;
  role: "firefighter" | "viewer" | "agent";
  at: string;
  text: string;
  citations?: Citation[];
  toolCalls?: ToolCall[];
};

export type ChatThread = {
  title: string;
  messages: ChatMessage[];
  suggestions: string[];
};

/** True when chat has no backend, which is currently always. */
export function chatIsDemoOnly(): boolean {
  return true;
}

export function getChatThread(): Promise<ChatThread> {
  if (isDemo() || chatIsDemoOnly()) return fixture(demoChatThread);
  // Unreachable while `chatIsDemoOnly` is true. Left as an explicit refusal so
  // that wiring a real transport is a deliberate edit here, not a silent
  // fallthrough to a fetch of a path that answers 404.
  return Promise.reject(new Error("chat has no backend route"));
}
