import { env } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import { getCounters } from "../src/db/counters";

const NOW = 1_700_000_000_000;
const DAY = 86_400_000;

beforeEach(async () => {
  await env.DB.batch([
    env.DB.prepare("DELETE FROM events_seen"),
    env.DB.prepare("DELETE FROM messages"),
  ]);
  await env.DB.batch([
    env.DB.prepare("INSERT INTO events_seen VALUES (?, ?, ?, ?)").bind("e1", "C1", "ingested", NOW),
    env.DB.prepare("INSERT INTO events_seen VALUES (?, ?, ?, ?)").bind("e2", "C1", "dropped_dm", NOW),
    env.DB.prepare("INSERT INTO events_seen VALUES (?, ?, ?, ?)").bind("e3", "C1", "dropped_bot", NOW),
    // yesterday — must not be counted
    env.DB.prepare("INSERT INTO events_seen VALUES (?, ?, ?, ?)").bind("e4", "C1", "ingested", NOW - DAY - 1),
  ]);
});

describe("getCounters", () => {
  it("counts heard as every envelope seen in the window", async () => {
    const c = await getCounters(env.DB, NOW - DAY);
    expect(c.heard).toBe(3);
  });

  it("counts ingested as the subset that survived the drop rules", async () => {
    const c = await getCounters(env.DB, NOW - DAY);
    expect(c.ingested).toBe(1);
  });

  it("excludes events outside the window", async () => {
    const c = await getCounters(env.DB, NOW - 1000);
    expect(c.heard).toBe(3);
  });

  it("returns zero for counters later phases populate", async () => {
    const c = await getCounters(env.DB, NOW - DAY);
    expect(c.triaged).toBe(0);
    expect(c.escalated).toBe(0);
  });

  it("returns all zeros for an empty window without throwing", async () => {
    const c = await getCounters(env.DB, NOW + DAY);
    expect(c).toEqual({ heard: 0, ingested: 0, triaged: 0, escalated: 0 });
  });
});
