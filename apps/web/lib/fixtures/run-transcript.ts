/**
 * Run transcripts in the shape the socket actually broadcasts.
 *
 * Deliberately the WIRE shape — `{ id, role, parts[] }` with `text` and
 * `tool-run_code` parts — rather than a prettier structure invented for the
 * demo. The renderer in `components/run/transcript.tsx` is the same one the
 * live socket feeds, so a fixture in a different shape would mean demo mode
 * exercising a component that production never runs.
 *
 * One `run_code` call carries every capability the agent used in a step, which
 * is why the tool rows here hold TypeScript rather than a tidy list of verbs.
 */

import { demoRuns } from "./runs";

/** The run a demo chat create resolves to. Stable, so `/runs/<id>` is linkable. */
export const DEMO_CHAT_RUN_ID = "b8d41f62-0c37-4a1e-9d55-3e6f2a8c7014";

/** The Lingua run that is parked on an approval, so its card has a thread to sit in. */
const DEMO_APPROVAL_RUN_ID = "a1c9e7d4-32b8-4f10-95aa-7c2e5b8d0446";

export type DemoPart =
  | { type: "text"; text: string }
  | {
      type: "tool-run_code";
      state: "output-available";
      input: { code: string };
      output: unknown;
    };

export type DemoMessage = {
  id: string;
  role: "user" | "assistant";
  parts: DemoPart[];
};

const RECALL_CODE = `const hits = await memory.search({
  graph: "customer:pulsefit",
  query: "checkout complaints",
  limit: 20,
});
return hits.map((h) => ({ day: h.day, quote: h.text, permalink: h.permalink }));`;

const SHIP_CODE = `const issue = await linear.create({
  title: "Track Android WebView fix rollout",
  description: "Follow-up on the tap-target regression reported in #zellify-pulsefit.",
});
const pr = await github.pr({
  title: \`changelog: \${issue.identifier}\`,
  body: \`Closes \${issue.identifier}\`,
});
return { issue: issue.identifier, pr: pr.number };`;

const DRAFT_CODE = `const docs = await files.search({ query: "funnel language variant" });
await approval.escalate({
  draft: "Add a language variant on the funnel itself — Editor → Settings → Languages.",
  why: "Tells the customer how a feature behaves. If the inheritance detail is wrong they will build on it.",
});
return { cited: docs.map((d) => d.path) };`;

/** The chat run: somebody asking the agent what it remembers, then handing it work. */
const chatTranscript: DemoMessage[] = [
  {
    id: "m1",
    role: "user",
    parts: [
      {
        type: "text",
        text: "did PulseFit complain about checkout before this week? what did we do back then?",
      },
    ],
  },
  {
    id: "m2",
    role: "assistant",
    parts: [
      {
        type: "tool-run_code",
        state: "output-available",
        input: { code: RECALL_CODE },
        output: [
          {
            day: "Jul 28",
            quote: "annual shows $9.999??",
            permalink: "https://zellify.slack.com/archives/C0PULSEFIT/p1785283200000100",
          },
          {
            day: "Jul 12",
            quote: "renewal double-count",
            permalink: "https://zellify.slack.com/archives/C0PULSEFIT/p1783900800000300",
          },
        ],
      },
      {
        type: "text",
        text: "Twice, both resolved. Jul 28 they hit a currency-rounding bug ($9.999 on the annual plan) — fixed same day in #1287. Jul 12 a webhook retry double-counted a renewal; we added dedupe and credited them manually. Today's Android tap issue is unrelated to either; the fix is in review.",
      },
    ],
  },
  {
    id: "m3",
    role: "user",
    parts: [
      {
        type: "text",
        text: "nice — file a Linear issue to track the Android fix rollout, and make sure it gets a changelog entry",
      },
    ],
  },
  {
    id: "m4",
    role: "assistant",
    parts: [
      {
        type: "tool-run_code",
        state: "output-available",
        input: { code: SHIP_CODE },
        output: { issue: "ZEL-2044", pr: 1312 },
      },
      {
        type: "text",
        text: 'Filed ZEL-2044 ("Track Android WebView fix rollout") and drafted the changelog entry as a PR that links it — review it on GitHub; the issue closes itself on merge.',
      },
    ],
  },
];

/**
 * The Slack run that is parked on an approval. It ends WITHOUT a reply, because
 * that is what `awaiting_approval` means: the draft exists, and it is in the
 * card below rather than in the transcript.
 */
const approvalTranscript: DemoMessage[] = [
  {
    id: "a1",
    role: "user",
    parts: [
      {
        type: "text",
        text: "how do we add a second language variant to the same funnel without duplicating the whole thing?",
      },
    ],
  },
  {
    id: "a2",
    role: "assistant",
    parts: [
      {
        type: "tool-run_code",
        state: "output-available",
        input: { code: DRAFT_CODE },
        output: { cited: ["docs/funnels/localisation.md", "docs/funnels/variants.md"] },
      },
      {
        type: "text",
        text: "Drafted a reply and escalated it — it explains a feature's behaviour to the customer, so a human signs it off before it goes out.",
      },
    ],
  },
];

/**
 * Anything else: the opening message, and the agent saying it is on it.
 *
 * Built from the run's own summary rather than shared verbatim across every
 * run, because a demo that shows one customer's conversation under another
 * customer's header teaches the reader that the transcript is decorative.
 */
function openingTranscript(runId: string): DemoMessage[] {
  const run = demoRuns.find((candidate) => candidate.id === runId);
  const opening = run?.summary;
  if (opening === undefined || opening === null) return [];

  return [
    { id: `${runId}:1`, role: "user", parts: [{ type: "text", text: opening }] },
    {
      id: `${runId}:2`,
      role: "assistant",
      parts: [
        {
          type: "tool-run_code",
          state: "output-available",
          input: {
            code: `const history = await memory.search({\n  graph: "customer:${run?.customerSlug ?? "org"}",\n  query: ${JSON.stringify(opening.slice(0, 48))},\n});\nreturn history.length;`,
          },
          output: 3,
        },
        {
          type: "text",
          text: "Reading the thread and what we've said to this customer before. I'll come back here with an answer.",
        },
      ],
    },
  ];
}

export function demoTranscriptFor(runId: string): DemoMessage[] {
  if (runId === DEMO_CHAT_RUN_ID) return chatTranscript;
  if (runId === DEMO_APPROVAL_RUN_ID) return approvalTranscript;
  return openingTranscript(runId);
}
