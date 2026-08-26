import { QueryClient } from "@tanstack/react-query";

import { ApiError } from "../api/errors";

/**
 * One cache for the whole app. This is the reason TanStack Query is here at
 * all: the speaker hero and the team table read the same `/api/roster`
 * document, and the sidebar badge reads the same open-approvals list the queue
 * does. With a cache they each ask for what they need and one request is made;
 * without one, the page has to fetch everything at the top and hand it down,
 * which is what the Vite dashboard does and says so in a comment.
 */
export function makeQueryClient(): QueryClient {
  return new QueryClient({
    defaultOptions: {
      queries: {
        // The tab is left open on a second monitor for hours. Coming back to it
        // should not show yesterday's queue.
        refetchOnWindowFocus: true,
        refetchOnReconnect: true,
        // Retrying a 401 or a 403 cannot succeed — Access decides both before
        // the request reaches a route, and no amount of backoff changes who you
        // are. Everything else gets two attempts.
        retry: (failureCount, error) => {
          if (error instanceof ApiError && error.kind !== "unavailable") return false;
          return failureCount < 2;
        },
      },
    },
  });
}
