import { z } from "zod";
import type { ToolDescriptors } from "@cloudflare/codemode/ai";
import type { JsonObject } from "../../run/protocol";
import { runEffect } from "../effects";
import { auditedCapability, effectDeps, type BindingContext } from "../registry";

const level = z.enum(["low", "medium", "high"]);

/**
 * The assessment is required, not optional. It is the thing that replaces the
 * banned ticket type: instead of classifying the work into a category, the
 * model has to state what it is worth and why, in fields a human can argue
 * with.
 */
const assessment = z.strictObject({
  platformValue: level,
  blocking: level,
  customerWeight: level,
  evidence: z.string().min(1).max(2000),
});

export function makeLinearTools(ctx: BindingContext): ToolDescriptors {
  return {
    createIssue: auditedCapability(ctx, "linear", "createIssue", {
      effect: "external_write",
      // No destination argument. The destination is pinned server-side; the
      // credential itself reaches every group in the account, so this pin is
      // the only thing that keeps the agent out of the live ones.
      description:
        "File an issue. Where it is filed is fixed by configuration and cannot be chosen here.",
      input: z.strictObject({
        title: z.string().min(1).max(255),
        description: z.string().min(1).max(20_000),
        assessment,
        labels: z.array(z.string().min(1).max(60)).max(10).optional(),
      }),
      output: z.strictObject({
        id: z.string(),
        identifier: z.string(),
        url: z.string(),
      }),
      run: async (input) => {
        const description = renderDescription(input.description, input.assessment);
        // Normalized ONCE and used for both the key and the request, so the key
        // describes exactly what was sent. The assessment needs no key field of
        // its own: renderDescription folds it into `description`, which is in
        // the key already.
        const labels = normalizeLabels(input.labels);
        // Reserved through the ledger so the idempotency key handed to Linear
        // IS the effect key. Linear accepts a client-supplied issue id and
        // refuses a duplicate, so the two mechanisms agree on what "the same
        // issue" means instead of each having its own opinion.
        return runEffect(
          effectDeps(ctx),
          ctx.scope,
          "linear",
          "createIssue",
          // `labels` is in the key because it changes what gets filed. Omitting
          // it made two issues that differ only by label one effect: the second
          // create replayed the first issue's URL and the labels were silently
          // never applied, with the model told it had succeeded.
          { title: input.title, description, labels },
          {
            execute: (idempotencyKey) =>
              ctx.deps.linear.createIssue({
                title: input.title,
                description,
                labels,
                idempotencyKey,
              }),
            // Turns an ambiguous 5xx into a decidable question. The create
            // supplies its own id, so "did this get filed?" is an exact lookup
            // rather than a guess at matching titles.
            reconcile: (idempotencyKey) => ctx.deps.linear.findIssue(idempotencyKey),
          },
        );
      },
    }),

    /**
     * Phase 20's gap-closer. A run only ever gets an issue's UUID back from
     * its OWN `createIssue` call — an issue an earlier run filed (FIR-3,
     * say) never lands in this run's hands that way, so there was no
     * documented path to reach for it before linking. This is that path: it
     * takes the human identifier the model can read off a Slack thread or a
     * PR description, and hands back enough to decide whether to link it.
     *
     * `read`, not `external_write` — it observes, it does not touch the
     * effect ledger, and it takes no `idempotencyKey`. Absence of the issue
     * is `null`, not a thrown error: "no such issue" is exactly the kind of
     * answer a model deciding whether to link something should get back
     * cleanly, not have to catch.
     */
    findIssue: auditedCapability(ctx, "linear", "findIssue", {
      effect: "read",
      description:
        "Look up an issue by its human identifier (e.g. `FIR-3`) — this is how you pick up an issue you did not create yourself in THIS run, before passing its id to openPR's fixesIssueIds/partOfIssueIds. Returns null, not an error, when there is no such issue or it is out of reach.",
      input: z.strictObject({
        // Deliberately narrow: `FIR-3` shape only, so this cannot be used to
        // probe the workspace with an arbitrary UUID. The team pin inside
        // the gateway is the real guard; this is defence in depth on top of
        // it, cheap because the model never has a legitimate reason to type
        // anything else here.
        identifier: z.string().regex(/^[A-Z][A-Z0-9]*-\d+$/).max(40),
      }),
      output: z
        .strictObject({
          id: z.string(),
          identifier: z.string(),
          url: z.string(),
          title: z.string(),
          state: z.string(),
        })
        .nullable(),
      run: (input) => ctx.deps.linear.lookupIssue(input.identifier),
    }),

    updateIssue: auditedCapability(ctx, "linear", "updateIssue", {
      effect: "external_write",
      description:
        "Update an issue this run already created or read. Fields left out are unchanged.",
      input: z.strictObject({
        issueId: z.string().min(1).max(200),
        title: z.string().min(1).max(255).optional(),
        description: z.string().min(1).max(20_000).optional(),
        state: z.string().min(1).max(60).optional(),
      }),
      output: z.strictObject({ id: z.string(), url: z.string() }),
      run: async (input) => {
        // Through the ledger, which it was not before Phase 10 Task 1. An
        // enabled mutator outside the ledger is fine only while nothing retries
        // it; the agent loop retries, so a crash between "sent" and "recorded"
        // would re-apply the edit and add a second entry to the issue's public
        // activity feed.
        //
        // Every field that changes what the edit DOES is in the key, and only
        // the fields actually supplied: `undefined` has no canonical form, and
        // "leave the title alone" is a different effect from "set the title to
        // X", so they must not hash alike.
        const patch: JsonObject = { issueId: input.issueId };
        if (input.title !== undefined) patch.title = input.title;
        if (input.description !== undefined) patch.description = input.description;
        if (input.state !== undefined) patch.state = input.state;

        return runEffect(
          effectDeps(ctx),
          ctx.scope,
          "linear",
          "updateIssue",
          patch,
          {
            // No `idempotencyKey` and no `reconcile`, deliberately, and this is
            // the residual risk to know about: Linear's update mutation takes
            // no client token, and reading the issue back cannot distinguish
            // "our edit landed" from "someone else set the same value". So an
            // ambiguous update stays `in_doubt` for a human rather than being
            // guessed at. The ledger reservation still gives the property that
            // matters here — a retry of this turn cannot apply the edit twice.
            execute: () => ctx.deps.linear.updateIssue(input),
          },
        );
      },
    }),
  };
}

/**
 * Sort, de-duplicate and NFC-normalize labels.
 *
 * Label ORDER is not meaning, so two orderings must not be two effects — but
 * `canonical()` preserves array order by design (for arrays where order IS
 * meaning), so the normalization has to happen here. Applied to the outgoing
 * request too, otherwise the key would describe something other than what was
 * sent.
 */
function normalizeLabels(labels: string[] | undefined): string[] {
  return [...new Set((labels ?? []).map((label) => label.normalize("NFC")))].sort();
}

/**
 * The assessment travels in the issue body rather than as structured fields,
 * because the reader is a human triaging a queue, not a query.
 *
 * Rendered under `## Notes` rather than a bare `---` divider, because that is
 * the monorepo's own `m-create-linear-task` convention: priority, estimate
 * and tier belong in native fields, and everything else that doesn't fit one
 * — which is exactly what this assessment is — goes under `## Notes`.
 */
function renderDescription(
  body: string,
  a: z.infer<typeof assessment>,
): string {
  return [
    body,
    "",
    "## Notes",
    "",
    `Platform value: ${a.platformValue}`,
    `Blocking: ${a.blocking}`,
    `Customer weight: ${a.customerWeight}`,
    "",
    `Evidence: ${a.evidence}`,
  ].join("\n");
}
