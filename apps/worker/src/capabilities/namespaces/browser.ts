import { z } from "zod";

import type { ClassifiedTool } from "../define";
import { CapabilityError } from "../../gateways/errors";
import { auditedCapability, type BindingContext } from "../registry";
import { MAX_RECORDING_TIMEOUT_MS } from "../../sandbox/record";

/**
 * The tenth namespace: a real browser on this run's own machine, and the
 * recording that proves what it did.
 *
 * Two methods, both `sandbox_write` for the same reason every `sandbox`
 * method is: they mutate an ephemeral machine this run owns and nobody else
 * can see. `record` follows the exact shape `sandbox.preview` and
 * `sandbox.spawn` already use for anything that cannot finish inside one
 * execution's budget — start, get a handle back, poll a LATER call for the
 * result — because a browser script plus a video flush plus an mp4 transcode
 * is minutes, not the 20s a `run_code` execution gets.
 *
 * THIS FILE HOLDS NO PLAYWRIGHT AND NO CONTAINER. Both methods are a thin,
 * schema-and-refusal layer over `ctx.deps.sandbox` — the same gateway the
 * `sandbox` namespace uses. `record`/`checkRecording` refuse with
 * `sandbox_not_ready` before `boot` has a ready machine for the identical
 * reason `sandbox.exec` does: the gateway's own readiness gate runs first,
 * inside every one of its methods, so this file adds no gate of its own and
 * cannot forget one.
 *
 * A BROWSERLESS MACHINE IS NOT A HANG OR A GENERIC FAILURE. The boot-time
 * Chromium install is non-fatal by design (Phase 19), so a container can
 * reach `ready` with no browser at all. `checkRecording` surfaces that as a
 * named, terminal `state: "failed"` result whose `error` names
 * `browser-unavailable` — a fact the model can act on (stop, do not retry)
 * rather than a cause it has to guess at.
 *
 * A FAILING REPRO IS A RESULT, NOT AN ERROR. `checkRecording` never throws
 * because the script inside `record` threw — that is `state: "failed"` with
 * Playwright's own message and a playable video of the failure, which is
 * exactly the evidence a bug report needs. Throwing here is reserved for what
 * it means everywhere else in this layer: the CALL failed, not the recording.
 */

const recordingStatus = z.strictObject({
  state: z.enum(["running", "passed", "failed"]),
  url: z.string().nullable(),
  error: z.string().nullable(),
  stdoutTail: z.string(),
  durationMs: z.number(),
});

export function makeBrowserTools(
  ctx: BindingContext
): Record<string, ClassifiedTool> {
  return {
    record: auditedCapability(ctx, "browser", "record", {
      effect: "sandbox_write",
      description:
        "Run a Playwright script with video recording, on this run's own container. `page` is already in scope — do not open a browser or a context yourself, do not call recordVideo, and do not call setViewportSize; the harness owns all three and records at a fixed 1280x720 — resizing the page only makes your own video letterbox with a grey band. Write the script as you would a Playwright test body and THROW to fail: the last expression's truthiness is never consulted. This does not block — it starts the recording and returns a recordingId; poll checkRecording for the result on a LATER turn, across blocks rather than in a loop inside this one, because a real run is minutes and this execution has seconds. WARM THE ROUTE BEFORE YOU RECORD: the recording starts the instant the page exists, before your first `goto`, and a dev server compiles a page on its first request — 5-40 seconds during which the video is blank white. Hit the URL first with `sandbox.exec` (`curl -s -o /dev/null -w '%{http_code}' http://localhost:4100/the-route`) and only call record once that answers 200; then the first navigation paints at once and the proof opens on the page, not on nothing. `timeoutMs` defaults to 60000 (60 seconds) and bounds the SCRIPT: if you could not warm the route, raise it, because a cold compile eats the budget and the run fails with \"script exceeded timeoutMs\", which looks exactly like the bug reproducing and is not. Anything above 180000 (3 minutes) is REFUSED rather than quietly shortened. `script` is capped at 20000 characters and `label` at 200; both are refused, not truncated. A script that throws is not a wasted call: the harness still flushes a playable video of the failure, and checkRecording returns it — that recording IS the proof a bug is real, so keep it rather than re-running for a clean one. If this run's machine never got a working browser, checkRecording reports that by name (browser-unavailable) instead of a generic failure or a hang.",
      input: z.strictObject({
        script: z.string().min(1).max(20_000),
        label: z.string().min(1).max(200),
        timeoutMs: z.number().int().min(1).optional(),
      }),
      output: z.strictObject({ recordingId: z.string() }),
      run: (input) => {
        if (input.timeoutMs !== undefined)
          assertRecordTimeoutInBudget(input.timeoutMs);
        return ctx.deps.sandbox.record({
          script: input.script,
          label: input.label,
          ...(input.timeoutMs === undefined
            ? {}
            : { timeoutMs: input.timeoutMs }),
        });
      },
    }),

    checkRecording: auditedCapability(ctx, "browser", "checkRecording", {
      effect: "sandbox_write",
      description:
        'Poll a recording record started. state: "running" means keep waiting — call again on a later turn, never in a tight loop here. Once it settles ("passed" or "failed"), url — when present — is a public link to a playable mp4: safe to paste as-is into a pull request body or a Slack message, no signing, no escaping, nothing else to fetch. error carries Playwright\'s own message when the script threw, trimmed to the useful part, or names browser-unavailable when this run\'s machine never got a working browser — either way it is a reason you can act on. A FAILED recording is a first-class result, not a dead end: its video is what proves the bug is real, and it is worth linking exactly like a passing one, not discarded in favor of a cleaner rerun.',
      input: z.strictObject({ recordingId: z.string().min(1).max(200) }),
      output: recordingStatus,
      run: (input) => ctx.deps.sandbox.checkRecording(input.recordingId),
    }),
  };
}

/**
 * Refuse, and name the alternative in the same breath — the same shape
 * `sandbox.ts`'s `assertTimeoutInBudget` uses, and for the same reason: the
 * model needs the number to pick a smaller one, so this is the one place that
 * quotes a limit rather than leaving it to `formatZodIssues`.
 *
 * The ceiling itself is `record.ts`'s `MAX_RECORDING_TIMEOUT_MS`, imported
 * rather than declared here a second time. Two constants for one bound is
 * exactly how this drifted once already: this file's `300_000` let a
 * `timeoutMs` between 180001 and 300000 pass validation, consume a call, and
 * then throw two layers deeper against a number the model was never told
 * about. The layer that enforces the value now owns it.
 */
function assertRecordTimeoutInBudget(timeoutMs: number): void {
  if (timeoutMs <= MAX_RECORDING_TIMEOUT_MS) return;
  throw new CapabilityError(
    "invalid_input",
    `timeoutMs ${timeoutMs} is above the ${MAX_RECORDING_TIMEOUT_MS}ms ceiling and the recording was NOT started. Use a smaller budget, or split the script into a shorter repro.`
  );
}
