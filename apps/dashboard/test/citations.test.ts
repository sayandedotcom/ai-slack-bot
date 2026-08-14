import { describe, expect, it } from "vitest";

import {
  channelFromPermalink,
  extractSources,
  linkifySlackUrls,
} from "../src/chat/citations";
import type { SessionItem } from "../src/runs/session-reducer";

const PERMALINK_A = "https://zellify.slack.com/archives/C0123ABCD/p1723600000000100";
const PERMALINK_B = "https://zellify.slack.com/archives/C0456EFGH/p1723600000000200";

function citeCall(
  output: unknown,
  state: "running" | "completed" | "failed" = "completed",
  callId = "call-1",
): SessionItem {
  return {
    kind: "tool_call",
    call: { callId, name: "memory.cite", state, output, startedAt: 1, endedAt: 2 },
  };
}

function entry(overrides: Partial<Record<"factId" | "fact" | "permalink" | "ts", string>> = {}) {
  return {
    factId: "f1",
    fact: "PulseFit hit a currency-rounding bug on the annual plan",
    permalink: PERMALINK_A,
    ts: "1723600000.000100",
    ...overrides,
  };
}

describe("extractSources", () => {
  it("yields chips from completed memory.cite calls in call order", () => {
    const items: SessionItem[] = [
      citeCall([entry()], "completed", "call-1"),
      citeCall([entry({ factId: "f2", permalink: PERMALINK_B })], "completed", "call-2"),
    ];
    expect(extractSources(items).map((chip) => chip.factId)).toEqual(["f1", "f2"]);
  });

  it("maps the permalink's channel segment into channelId", () => {
    const [chip] = extractSources([citeCall([entry()])]);
    expect(chip?.channelId).toBe("C0123ABCD");
  });

  it("ignores running and failed cite calls", () => {
    const items: SessionItem[] = [
      citeCall([entry()], "running"),
      citeCall([entry()], "failed", "call-2"),
    ];
    expect(extractSources(items)).toEqual([]);
  });

  it("ignores non-cite tool calls and non-tool items", () => {
    const items: SessionItem[] = [
      {
        kind: "tool_call",
        call: { callId: "c", name: "memory.recall", state: "completed", output: [entry()], startedAt: 1, endedAt: 2 },
      },
      { kind: "turn", turn: { id: "t1", role: "assistant", source: "agent", content: PERMALINK_A, createdAt: 1 } },
    ];
    expect(extractSources(items)).toEqual([]);
  });

  it("dedupes by permalink keeping the first", () => {
    const items: SessionItem[] = [
      citeCall([entry(), entry({ factId: "f2" })], "completed", "call-1"),
    ];
    const chips = extractSources(items);
    expect(chips).toHaveLength(1);
    expect(chips[0]?.factId).toBe("f1");
  });

  it("contributes nothing and throws nothing on malformed output", () => {
    const items: SessionItem[] = [
      citeCall(undefined),
      citeCall("not an array", "completed", "call-2"),
      citeCall([{ fact: "missing everything else" }], "completed", "call-3"),
      citeCall([entry({ permalink: undefined as unknown as string })], "completed", "call-4"),
    ];
    expect(extractSources(items)).toEqual([]);
  });
});

describe("channelFromPermalink", () => {
  it("extracts the channel segment", () => {
    expect(channelFromPermalink(PERMALINK_A)).toBe("C0123ABCD");
  });

  it("returns null for non-archive or non-slack URLs", () => {
    expect(channelFromPermalink("https://example.com/archives/C0123ABCD/p1")).toBeNull();
    expect(channelFromPermalink("https://zellify.slack.com/messages/C0123ABCD")).toBeNull();
  });
});

describe("linkifySlackUrls", () => {
  it("splits one embedded permalink into three segments, URL byte-exact", () => {
    expect(linkifySlackUrls(`see ${PERMALINK_A} for the thread`)).toEqual([
      { kind: "text", text: "see " },
      { kind: "link", url: PERMALINK_A },
      { kind: "text", text: " for the thread" },
    ]);
  });

  it("returns one text segment when there is no URL", () => {
    expect(linkifySlackUrls("no links here")).toEqual([{ kind: "text", text: "no links here" }]);
  });

  it("handles a URL at the start, at the end, and two URLs", () => {
    expect(linkifySlackUrls(`${PERMALINK_A} then ${PERMALINK_B}`)).toEqual([
      { kind: "link", url: PERMALINK_A },
      { kind: "text", text: " then " },
      { kind: "link", url: PERMALINK_B },
    ]);
  });

  it("leaves a scheme-less URL-shaped string as text — never guess", () => {
    const bare = "zellify.slack.com/archives/C0123ABCD/p1";
    expect(linkifySlackUrls(bare)).toEqual([{ kind: "text", text: bare }]);
  });

  it("returns no segments for the empty string", () => {
    expect(linkifySlackUrls("")).toEqual([]);
  });
});
