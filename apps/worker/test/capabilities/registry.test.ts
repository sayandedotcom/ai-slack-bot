import { describe, expect, it } from "vitest";

import { capabilityEffectOf } from "../../src/capabilities/define";
import {
  buildNamespaces,
  CAPABILITY_NAMESPACES,
} from "../../src/capabilities/registry";
import { testBindingContext } from "../helpers/capabilities";

describe("capability registry", () => {
  it("classifies every method with an effect", () => {
    for (const ns of buildNamespaces(testBindingContext())) {
      for (const [method, tool] of Object.entries(ns.tools)) {
        expect(capabilityEffectOf(tool), `${ns.name}.${method}`).not.toBeNull();
      }
    }
  });

  it("keeps every method name globally unique across namespaces", () => {
    // The .d.ts generator types by METHOD NAME alone, with no namespace prefix,
    // so slack.search and langsmith.search would both emit `type SearchInput`
    // and the joined declaration file would not compile. Enforced on the
    // DERIVED PascalCase name, which is what actually collides.
    const seen = new Map<string, string>();
    for (const ns of buildNamespaces(testBindingContext())) {
      for (const method of Object.keys(ns.tools)) {
        const pascal = method.slice(0, 1).toUpperCase() + method.slice(1);
        expect(
          seen.has(pascal),
          `${pascal} also from ${seen.get(pascal)}`
        ).toBe(false);
        seen.set(pascal, ns.name);
      }
    }
  });

  it("renders namespaces in the frozen order", () => {
    // Order is the order the model reads its API in, and the order the
    // committed .d.ts renders. A reshuffle is a reviewable diff, not a nit.
    const built = buildNamespaces(testBindingContext()).map((n) => n.name);
    expect(built).toEqual(
      CAPABILITY_NAMESPACES.filter((n) => built.includes(n))
    );
  });

  it("does not share a call budget between two contexts", () => {
    const a = buildNamespaces(testBindingContext());
    const b = buildNamespaces(testBindingContext());
    expect(a[0]).not.toBe(b[0]);
  });
});
