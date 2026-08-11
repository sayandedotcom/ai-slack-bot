import { Hono } from "hono";
import type { Env } from "../index";
import { getCounters } from "../db/counters";

export const countersApi = new Hono<{ Bindings: Env }>();

countersApi.get("/counters", async (c) => {
  const since = Date.now() - 86_400_000;
  const counters = await getCounters(c.env.DB, since);
  return c.json({ counters, since });
});
