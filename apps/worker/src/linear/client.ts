import { CapabilityError } from "../codemode/errors";
import type { IssueRef, LinearGateway } from "../codemode/gateways";

/**
 * Pinned in code, not configuration. An origin that can be supplied is an
 * origin that can be redirected, and this client carries a credential with
 * workspace-wide reach.
 */
const LINEAR_ORIGIN = "https://api.linear.app/graphql";

/**
 * Verified live 2026-08-12: a BARE token, with no `Bearer ` prefix. Sending the
 * prefix silently authenticates as nobody and every query returns null.
 */
function headers(apiKey: string): HeadersInit {
  return { authorization: apiKey, "content-type": "application/json" };
}

export type LinearConfig = {
  apiKey: string;
  /**
   * The one team this agent may touch. The API key is NOT scoped to it — it
   * reaches all five teams in the workspace including Development — so this pin
   * is the only thing keeping the agent out of live work. It must never come
   * from a caller.
   */
  teamId: string;
  teamName: string;
};

type GraphQLResponse<T> = {
  data?: T | null;
  errors?: Array<{
    message?: string;
    extensions?: { code?: string; userPresentableMessage?: string };
  }>;
};

/** True when Linear refused a create because that id already exists. */
function isDuplicateId(response: GraphQLResponse<unknown>): boolean {
  return (response.errors ?? []).some(
    (e) =>
      e.extensions?.code === "INPUT_ERROR" &&
      /already exists|conflict on insert/i.test(
        `${e.message ?? ""} ${e.extensions?.userPresentableMessage ?? ""}`,
      ),
  );
}

/**
 * Map an upstream failure to something safe, split by the only question that
 * matters to the effect ledger: **could the server have processed this?**
 *
 * A request that never arrived (no response at all) or was rejected at the door
 * (401, 403, 429) definitely did not file anything, so it maps to a code the
 * ledger treats as proven and a retry is allowed. A 5xx might have been
 * processed with the response lost, so it stays unproven and becomes
 * `effect_in_doubt` — resolvable later by `findIssue`, because the create
 * supplies its own id.
 *
 * The GraphQL document, the authorization header and the raw response body all
 * stay in this file.
 */
function upstreamError(status: number): CapabilityError {
  if (status === 401 || status === 403) {
    return new CapabilityError(
      "capability_unavailable",
      "issue tracking is not authorised right now, and nothing was filed. Report the issue in your summary instead.",
    );
  }
  if (status === 429) {
    return new CapabilityError(
      "capability_unavailable",
      "issue tracking is rate limited and refused the request, so nothing was filed. Wait before trying again.",
    );
  }
  if (status === 0) {
    return new CapabilityError(
      "capability_unavailable",
      "issue tracking could not be reached, so nothing was filed.",
    );
  }
  return new CapabilityError(
    "upstream_unavailable",
    "issue tracking failed while handling the request; whether anything was filed is unknown.",
  );
}

/**
 * Derive a stable UUID from the effect key.
 *
 * `IssueCreateInput.id` accepts a client-supplied UUID, and creating twice with
 * the same one fails with `conflict on insert of Issue` (verified live
 * 2026-08-12). That makes it a real idempotency facility: a retry cannot file a
 * second issue, and the conflict is the signal to reconcile rather than an
 * error to surface. Version and variant nibbles are forced so Linear accepts it
 * as a well-formed v4.
 */
export function issueIdFromEffectKey(effectKey: string): string {
  const hex = effectKey.replace(/[^0-9a-f]/gi, "").padEnd(32, "0").slice(0, 32);
  const version = `4${hex.slice(13, 16)}`;
  const variant = `${"89ab"[parseInt(hex[16], 16) % 4]}${hex.slice(17, 20)}`;
  return [
    hex.slice(0, 8),
    hex.slice(8, 12),
    version,
    variant,
    hex.slice(20, 32),
  ].join("-");
}

export function makeLinearGateway(config: LinearConfig): LinearGateway {
  async function query<T>(
    document: string,
    variables: Record<string, unknown>,
  ): Promise<GraphQLResponse<T>> {
    let response: Response;
    try {
      response = await fetch(LINEAR_ORIGIN, {
        method: "POST",
        headers: headers(config.apiKey),
        body: JSON.stringify({ query: document, variables }),
      });
    } catch {
      throw upstreamError(0);
    }
    if (!response.ok && response.status !== 400) {
      // 400 carries userError payloads we need to inspect (duplicate id).
      throw upstreamError(response.status);
    }
    try {
      return (await response.json()) as GraphQLResponse<T>;
    } catch {
      throw new CapabilityError(
        "upstream_unavailable",
        "issue tracking returned something unreadable. Nothing was filed.",
      );
    }
  }

  /**
   * The one shape both `requirePinnedIssue` and `lookupIssue` need — the
   * union of what a `Fixes` line requires (`id`, `identifier`) and what a
   * model deciding whether to link an issue wants to see (`url`, `title`,
   * `state`) — fetched by a single GraphQL document so there is exactly one
   * query string to keep in sync with the schema, not two drifting copies
   * that happen to overlap on `id`/`identifier`/`team`.
   */
  async function fetchIssue(issueId: string): Promise<{
    id: string;
    identifier: string;
    url: string;
    title: string;
    state: { name: string };
    team: { id: string };
  } | null> {
    const result = await query<{
      issue: {
        id: string;
        identifier: string;
        url: string;
        title: string;
        state: { name: string };
        team: { id: string };
      } | null;
    }>(
      `query($id: String!) { issue(id: $id) { id identifier url title state { name } team { id } } }`,
      { id: issueId },
    );
    return result.data?.issue ?? null;
  }

  /**
   * The team-pin refusal, in exactly one place. Both `requirePinnedIssue`
   * (existing issue mutators) and `lookupIssue` (Phase 20's read) call this
   * rather than each carrying their own copy of the message — a duplicated
   * string is exactly the kind of thing a later edit updates in one place
   * and not the other.
   */
  function assertPinnedTeam(issue: { team: { id: string } }): void {
    if (issue.team.id !== config.teamId) {
      throw new CapabilityError(
        "linear_team_denied",
        `that issue belongs to another team; this agent may only touch ${config.teamName}.`,
      );
    }
  }

  /**
   * Fetch an issue and prove it belongs to the pinned team before touching
   * it. Unlike `lookupIssue`, absence is a hard refusal here rather than an
   * honest `null`: every existing caller (`updateIssue`, `resolveLinkTargets`)
   * already holds an id it expects to resolve, so a miss means the id was
   * wrong, not that "no such issue" is a legitimate answer to act on.
   */
  async function requirePinnedIssue(
    issueId: string,
  ): Promise<{ id: string; identifier: string }> {
    const issue = await fetchIssue(issueId);
    if (issue === null) {
      throw new CapabilityError(
        "invalid_input",
        "that issue does not exist, or is not visible to this agent.",
      );
    }
    assertPinnedTeam(issue);
    return { id: issue.id, identifier: issue.identifier };
  }

  /**
   * Labels whose automation belongs to someone else. Verified live 2026-08-15:
   * the workspace carries a `Devin Playbooks` group — `!triage`, `!plan`,
   * `!implement`, `!review` — and labels are WORKSPACE-wide, not team-scoped,
   * so the team pin does not keep them out of reach. Applying one from here
   * would hand our issue to another team's agent. The model picks label names
   * freely, so this is a filter, not a convention we can document and trust.
   */
  const FOREIGN_AUTOMATION_LABEL = /^!/;

  /**
   * Linear's read API returns label NAMES (`labels: ["Leverage","Integration"]`)
   * but `issueCreate` requires label UUIDs. Passing the names straight through
   * silently drops every label — the issue files, unlabelled, and nothing
   * errors. Verified against the live workspace: `Bug` is
   * `1222a88e-6b42-46c0-b19b-1c7ec3190393`.
   *
   * Resolved at call time rather than from a hardcoded table, because a table
   * goes stale the first time someone adds a label and the failure is silent
   * in exactly the same way.
   *
   * An unknown name is DROPPED, not an error. The issue is the deliverable; a
   * label the model invented is not worth failing a create that a customer is
   * waiting on. The dropped names are returned so the caller can say so.
   */
  async function resolveLabelIds(
    names: readonly string[],
  ): Promise<{ ids: string[]; dropped: string[] }> {
    if (names.length === 0) return { ids: [], dropped: [] };
    const result = await query<{ issueLabels: { nodes: Array<{ id: string; name: string }> } }>(
      `query { issueLabels(first: 250) { nodes { id name } } }`,
      {},
    );
    const nodes = result.data?.issueLabels?.nodes ?? [];
    const byName = new Map(nodes.map((n) => [n.name.toLowerCase(), n]));

    const ids: string[] = [];
    const dropped: string[] = [];
    for (const name of names) {
      const hit = byName.get(name.toLowerCase());
      if (hit === undefined || FOREIGN_AUTOMATION_LABEL.test(hit.name)) {
        dropped.push(name);
        continue;
      }
      ids.push(hit.id);
    }
    return { ids, dropped };
  }

  return {
    async createIssue(input): Promise<IssueRef> {
      const id = issueIdFromEffectKey(input.idempotencyKey);
      const { ids: labelIds } = await resolveLabelIds(input.labels);
      const result = await query<{
        issueCreate: { success: boolean; issue: IssueRef | null };
      }>(
        `mutation($id: String!, $title: String!, $description: String!, $teamId: String!, $labelIds: [String!]) {
           issueCreate(input: { id: $id, title: $title, description: $description, teamId: $teamId, labelIds: $labelIds }) {
             success
             issue { id identifier url }
           }
         }`,
        {
          id,
          title: input.title,
          description: input.description,
          // The team is injected here and appears in no model-facing schema.
          teamId: config.teamId,
          // UUIDs, never the names the model supplied — see resolveLabelIds.
          labelIds: labelIds.length > 0 ? labelIds : undefined,
        },
      );

      if (isDuplicateId(result)) {
        // A previous attempt already filed it. Return the existing issue rather
        // than creating a second one — this is the reconciliation path, and it
        // is a success, not a failure.
        const existing = await query<{ issue: IssueRef | null }>(
          `query($id: String!) { issue(id: $id) { id identifier url } }`,
          { id },
        );
        if (existing.data?.issue) return existing.data.issue;
        throw new CapabilityError(
          "effect_in_doubt",
          "an issue with this identity already exists but could not be read back. Do not file again; ask a human to check.",
        );
      }

      const created = result.data?.issueCreate;
      if (!created?.success || !created.issue) {
        throw new CapabilityError(
          "upstream_unavailable",
          "the issue was not created. Nothing was filed.",
        );
      }
      return {
        id: created.issue.id,
        identifier: created.issue.identifier,
        url: created.issue.url,
      };
    },

    async findIssue(idempotencyKey): Promise<IssueRef | null> {
      const result = await query<{ issue: IssueRef | null }>(
        `query($id: String!) { issue(id: $id) { id identifier url } }`,
        { id: issueIdFromEffectKey(idempotencyKey) },
      );
      return result.data?.issue ?? null;
    },

    async updateIssue(input): Promise<{ id: string; url: string }> {
      await requirePinnedIssue(input.issueId);

      let stateId: string | undefined;
      if (input.state !== undefined) {
        // States are resolved WITHIN the pinned team, so a state name cannot
        // reach across teams even if two teams share one.
        const states = await query<{
          team: { states: { nodes: Array<{ id: string; name: string }> } } | null;
        }>(
          `query($teamId: String!) { team(id: $teamId) { states { nodes { id name } } } }`,
          { teamId: config.teamId },
        );
        const match = (states.data?.team?.states.nodes ?? []).find(
          (s) => s.name.toLowerCase() === input.state?.toLowerCase(),
        );
        if (match === undefined) {
          const names = (states.data?.team?.states.nodes ?? [])
            .map((s) => s.name)
            .join(", ");
          throw new CapabilityError(
            "invalid_input",
            `unknown state. Available states are: ${names}.`,
          );
        }
        stateId = match.id;
      }

      const result = await query<{
        issueUpdate: { success: boolean; issue: { id: string; url: string } | null };
      }>(
        `mutation($id: String!, $title: String, $description: String, $stateId: String) {
           issueUpdate(id: $id, input: { title: $title, description: $description, stateId: $stateId }) {
             success
             issue { id url }
           }
         }`,
        {
          id: input.issueId,
          title: input.title,
          description: input.description,
          stateId,
        },
      );

      const updated = result.data?.issueUpdate;
      if (!updated?.success || !updated.issue) {
        throw new CapabilityError(
          "upstream_unavailable",
          "the issue was not updated.",
        );
      }
      return { id: updated.issue.id, url: updated.issue.url };
    },

    /**
     * Turns the issue UUIDs the agent holds into the `{id, identifier}` pairs
     * a `Fixes FIR-123` line needs. That line, in the PR body, is the only
     * thing that makes the linked issue close on merge — so a partially
     * resolved result is worse than none: it renders some `Fixes` lines,
     * closes some issues, and silently drops the rest. The whole call
     * refuses the moment ANY id turns out foreign or unknown, before a
     * partial list can reach the caller.
     *
     * `requirePinnedIssue` does the fetch-then-check-team-pin work and
     * throws the two refusal codes; this just loops it in input order and
     * only returns once every id has cleared it, so a throw at any index
     * unwinds before `out` is ever handed back.
     *
     * Empty input makes zero requests: there is nothing to resolve, and a
     * capability that touches the network for a no-op list would burn a
     * sub-request against the caller's budget for nothing.
     *
     * One request per id (the caller caps the list at 5, per the brief), run
     * in order so the result order matches the input order: the PR body
     * renders one `Fixes` line per entry, and their order is visible output.
     */
    async resolveLinkTargets(
      issueIds,
    ): Promise<Array<{ id: string; identifier: string }>> {
      if (issueIds.length === 0) return [];

      const out: Array<{ id: string; identifier: string }> = [];
      for (const issueId of issueIds) {
        out.push(await requirePinnedIssue(issueId));
      }
      return out;
    },

    /**
     * The read that makes "link an issue this run did not create" possible
     * without the model guessing. `identifier` is passed straight through as
     * `issue(id: $id)`'s argument — Linear's API accepts a human identifier
     * (`FIR-3`) there just as readily as a UUID, verified live 2026-08-15,
     * which is what lets this share `fetchIssue` with `requirePinnedIssue`
     * rather than needing a second lookup mutation.
     */
    async lookupIssue(identifier) {
      const issue = await fetchIssue(identifier);
      if (issue === null) return null;
      assertPinnedTeam(issue);
      return {
        id: issue.id,
        identifier: issue.identifier,
        url: issue.url,
        title: issue.title,
        state: issue.state.name,
      };
    },
  };
}
