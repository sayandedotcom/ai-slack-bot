import { Hono } from "hono";
import { getCounters } from "../db/counters";
import type { Env } from "../index";
import { requireTeamMember } from "./identity";

export const countersApi = new Hono<{ Bindings: Env }>();

/** The two windows the dashboard offers. Anything else is a 400, not a guess. */
const WINDOWS = {
  "24h": 86_400_000,
  "7d": 7 * 86_400_000,
} as const;
type Window = keyof typeof WINDOWS;

function isWindow(value: string): value is Window {
  return Object.hasOwn(WINDOWS, value);
}

countersApi.get("/counters", async (c) => {
  const member = await requireTeamMember(c);
  if (member instanceof Response) return member;

  const windowParam = c.req.query("window") ?? "24h";
  if (!isWindow(windowParam)) {
    return c.json(
      { code: "invalid_window", message: "window must be 24h or 7d" },
      400
    );
  }

  const since = Date.now() - WINDOWS[windowParam];
  const counters = await getCounters(c.env.DB, since);
  return c.json({ counters, since, window: windowParam });
});
