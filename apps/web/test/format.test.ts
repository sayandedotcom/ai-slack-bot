import { describe, expect, it } from "vitest";

import { ago, initialOf, nameOf, shortThread, usd } from "@/lib/format";

const now = 1_787_740_000_000;
const minutesAgo = (n: number) => now - n * 60_000;

describe("ago", () => {
  it("says `just now` under a minute", () => {
    expect(ago(now - 1_000, now)).toBe("just now");
    expect(ago(now - 59_000, now)).toBe("just now");
  });

  it("counts minutes, then hours, then days", () => {
    expect(ago(minutesAgo(1), now)).toBe("1m ago");
    expect(ago(minutesAgo(59), now)).toBe("59m ago");
    expect(ago(minutesAgo(60), now)).toBe("1h ago");
    expect(ago(minutesAgo(23 * 60), now)).toBe("23h ago");
    expect(ago(minutesAgo(24 * 60), now)).toBe("1d ago");
  });

  it("clamps a future timestamp instead of counting backwards", () => {
    // Clock skew between the worker and a browser is real; "in -3m" is not a
    // thing anyone should ever read on this page.
    expect(ago(now + 180_000, now)).toBe("just now");
  });
});

describe("nameOf / initialOf", () => {
  it("keeps the local part and falls back to the whole string", () => {
    expect(nameOf("luka@zellify.app")).toBe("luka");
    expect(nameOf("luka")).toBe("luka");
  });

  it("gives an uppercase initial, and a question mark for nothing", () => {
    expect(initialOf("luka@zellify.app")).toBe("L");
    expect(initialOf("   ")).toBe("?");
    expect(initialOf("")).toBe("?");
  });
});

describe("shortThread", () => {
  it("keeps the distinguishing tail of a Slack thread key", () => {
    expect(shortThread("1787734021.000400")).toBe("…000400");
  });

  it("leaves an already-short key alone", () => {
    expect(shortThread("12345")).toBe("12345");
  });
});

describe("usd", () => {
  it("formats without parsing, so a ledger total is never rounded", () => {
    expect(usd("0.9042")).toBe("$0.9042");
    expect(usd("12.0000000001")).toBe("$12.0000000001");
  });
});
