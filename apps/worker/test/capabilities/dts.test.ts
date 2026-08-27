import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";

import { FirefighterConnector } from "../../src/capabilities/connector";
import {
  renderCapabilityDeclarations,
  renderDeclarationsFromConnectors,
} from "../../src/capabilities/dts";
import generated from "../../src/capabilities/generated/capabilities.d.ts?raw";
import { buildNamespaces } from "../../src/capabilities/registry";
import { testBindingContext } from "../helpers/capabilities";

describe("capability declarations", () => {
  it("renders identically from the registry and from the connectors", async () => {
    // `capabilities:dts:check` compares the CONNECTOR render against the
    // committed artifact and says nothing about what the runtime renders. If
    // these two drifted, the committed .d.ts would be reviewed and correct
    // while the model was quietly handed something else — the one kind of
    // drift the check cannot see.
    const namespaces = buildNamespaces(testBindingContext());
    const fromRegistry = renderCapabilityDeclarations(namespaces);
    const fromConnectors = await renderDeclarationsFromConnectors(
      namespaces.map(
        (ns) =>
          new FirefighterConnector(
            {} as ExecutionContext,
            env,
            {
              name: ns.name,
              instructions: ns.instructions,
              build: () => ns.tools,
            },
            async () => undefined
          )
      )
    );
    expect(fromConnectors).toBe(fromRegistry);
  });

  it("matches the committed artifact", async () => {
    const namespaces = buildNamespaces(testBindingContext());
    const rendered = await renderDeclarationsFromConnectors(
      namespaces.map(
        (ns) =>
          new FirefighterConnector(
            {} as ExecutionContext,
            env,
            {
              name: ns.name,
              instructions: ns.instructions,
              build: () => ns.tools,
            },
            async () => undefined
          )
      )
    );
    expect(rendered).toBe(generated);
  });

  it("degrades no capability to `unknown`", () => {
    // A raw Zod schema handed to a connector renders `type XInput = unknown`
    // with the description dropped, and nothing errors. This is the assertion
    // that notices.
    const rendered = renderCapabilityDeclarations(
      buildNamespaces(testBindingContext())
    );
    expect(rendered).not.toMatch(/=\s*unknown\b/);
  });

  it("carries each method's description into the declarations", () => {
    const rendered = renderCapabilityDeclarations(
      buildNamespaces(testBindingContext())
    );
    expect(rendered).toContain(
      "Read the messages of the conversation this run belongs to"
    );
  });
});
