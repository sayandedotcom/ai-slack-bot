/**
 * The chassis probe: `fetchChassis` (a plain async function) and `useChassis`
 * (a hook). Phase 25 ships BOTH session views in one bundle and picks between
 * them from this one answer, so a wrong or invented value here renders a run on
 * the implementation the operator did not deploy.
 *
 * There is no DOM in this package's vitest run — `apps/dashboard` has no vitest
 * config at all, so the environment is the default `node`, and neither
 * jsdom/happy-dom nor `@testing-library/react` is installed. Rather than leave
 * the hook untested (it holds the degrade-to-legacy rule, which is the only
 * thing standing between a flaky probe and a blank dashboard), the two hooks it
 * uses are mocked with a tiny synchronous host below: `useState` is a cell that
 * re-renders on write, `useEffect` is a deps-compared slot flushed after render.
 * That is enough for a hook whose entire body is one `useState` and one
 * mount-only `useEffect`, and it involves no renderer and no document.
 */

import { afterEach, describe, expect, it, vi } from "vitest";

type EffectFn = () => (() => void) | void;

/** What the mocked `react` calls into. Populated only during a render. */
type Dispatcher = {
  useState: (initial: unknown) => [unknown, (value: unknown) => void];
  useEffect: (fn: EffectFn, deps?: readonly unknown[]) => void;
};

// `vi.hoisted` so the `vi.mock` factory (which is hoisted above the imports) may
// close over this container without touching a temporal-dead-zone binding.
const dispatcher = vi.hoisted(() => ({ current: null as Dispatcher | null }));

vi.mock("react", async (importOriginal) => {
  const actual = await importOriginal<typeof import("react")>();
  return {
    ...actual,
    useState: (initial: unknown) => {
      if (dispatcher.current === null) throw new Error("useState called outside renderHook");
      return dispatcher.current.useState(initial);
    },
    useEffect: (fn: EffectFn, deps?: readonly unknown[]) => {
      if (dispatcher.current === null) throw new Error("useEffect called outside renderHook");
      dispatcher.current.useEffect(fn, deps);
    },
  };
});

// Imported AFTER the mock declaration for readability only — `vi.mock` is
// hoisted, so `chassis.ts` binds the mocked `react` either way.
import { fetchChassis, useChassis } from "../src/lib/chassis";
import type { ChassisState } from "../src/lib/chassis";

type Cell = { value: unknown };
type EffectSlot = { deps: readonly unknown[] | undefined; cleanup: (() => void) | undefined };

class HookHost implements Dispatcher {
  private readonly cells: Cell[] = [];
  private readonly effects: EffectSlot[] = [];
  private readonly queue: { index: number; fn: EffectFn }[] = [];
  private cellIndex = 0;
  private effectIndex = 0;
  result: unknown = undefined;
  renders = 0;

  constructor(private readonly hook: () => unknown) {}

  mount(): void {
    this.render();
    this.flush();
  }

  unmount(): void {
    for (const slot of this.effects) slot.cleanup?.();
  }

  useState(initial: unknown): [unknown, (value: unknown) => void] {
    const index = this.cellIndex++;
    let cell = this.cells[index];
    if (cell === undefined) {
      cell = { value: typeof initial === "function" ? (initial as () => unknown)() : initial };
      this.cells[index] = cell;
    }
    const target = cell;
    const setState = (value: unknown): void => {
      const next =
        typeof value === "function" ? (value as (previous: unknown) => unknown)(target.value) : value;
      if (Object.is(next, target.value)) return;
      target.value = next;
      this.render();
      this.flush();
    };
    return [cell.value, setState];
  }

  useEffect(fn: EffectFn, deps?: readonly unknown[]): void {
    const index = this.effectIndex++;
    const slot = this.effects[index];
    const previousDeps = slot?.deps;
    const changed =
      slot === undefined ||
      deps === undefined ||
      previousDeps === undefined ||
      deps.length !== previousDeps.length ||
      deps.some((dep, i) => !Object.is(dep, previousDeps[i]));
    if (slot === undefined) this.effects[index] = { deps, cleanup: undefined };
    else slot.deps = deps;
    if (changed) this.queue.push({ index, fn });
  }

  private render(): void {
    const previous = dispatcher.current;
    dispatcher.current = this;
    this.cellIndex = 0;
    this.effectIndex = 0;
    this.renders += 1;
    try {
      this.result = this.hook();
    } finally {
      dispatcher.current = previous;
    }
  }

  private flush(): void {
    const pending = this.queue.splice(0, this.queue.length);
    for (const { index, fn } of pending) {
      const slot = this.effects[index];
      if (slot === undefined) continue;
      slot.cleanup?.();
      const cleanup = fn();
      slot.cleanup = typeof cleanup === "function" ? cleanup : undefined;
    }
  }
}

function renderHook<T>(hook: () => T): {
  current: () => T;
  renders: () => number;
  unmount: () => void;
} {
  const host = new HookHost(hook as () => unknown);
  host.mount();
  return {
    current: () => host.result as T,
    renders: () => host.renders,
    unmount: () => host.unmount(),
  };
}

/** Drain the microtask queue — the probe resolves in promises, never on a timer. */
async function settle(ticks = 20): Promise<void> {
  for (let i = 0; i < ticks; i++) await Promise.resolve();
}

function stubFetch(impl: (input: string) => Promise<Response> | Response) {
  const spy = vi.fn((input: unknown) => impl(String(input)));
  vi.stubGlobal("fetch", spy);
  return spy;
}

function jsonResponse(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
  dispatcher.current = null;
});

describe("fetchChassis", () => {
  it("accepts exactly think and legacy from /api/chassis and throws on every other value", async () => {
    const requested: string[] = [];
    stubFetch((input) => {
      requested.push(input);
      return jsonResponse({ chassis: "think" });
    });
    await expect(fetchChassis()).resolves.toBe("think");
    expect(requested).toEqual(["/api/chassis"]);

    stubFetch(() => jsonResponse({ chassis: "legacy" }));
    await expect(fetchChassis()).resolves.toBe("legacy");

    // Everything else is a refusal, not a guess: coercing an unknown value would
    // render the run on a session implementation nobody deployed.
    for (const value of ["Think", "THINK", "think ", "rundo", "", null, 0, 1, true, undefined, ["think"], { chassis: "think" }]) {
      stubFetch(() => jsonResponse({ chassis: value }));
      await expect(fetchChassis(), `chassis: ${JSON.stringify(value) ?? "undefined"}`).rejects.toThrow();
    }

    // A body with no `chassis` key at all is the same refusal.
    stubFetch(() => jsonResponse({}));
    await expect(fetchChassis()).rejects.toThrow();
  });
});

describe("useChassis", () => {
  it("degrades to legacy with degraded true when the chassis probe fails", async () => {
    // A transport failure — `getJson` turns this into ApiError(0, "unavailable").
    stubFetch(() => {
      throw new TypeError("Failed to fetch");
    });

    const view = renderHook<ChassisState>(() => useChassis());
    expect(view.current()).toEqual({ kind: "loading" });

    await settle();

    // Legacy, and flagged: the dashboard must be able to SAY it guessed rather
    // than silently present a fallback as the deployed answer.
    expect(view.current()).toEqual({ kind: "ready", chassis: "legacy", degraded: true });
    view.unmount();
  });

  it("spends exactly one fetch on that degradation and never polls afterwards", async () => {
    vi.useFakeTimers();
    const fetchSpy = stubFetch(() => new Response("nope", { status: 503 }));

    const view = renderHook<ChassisState>(() => useChassis());
    await settle();
    expect(view.current()).toEqual({ kind: "ready", chassis: "legacy", degraded: true });
    expect(fetchSpy).toHaveBeenCalledTimes(1);

    // No timer was armed at all — a retry loop would show up here before it ever
    // showed up as a second fetch.
    expect(vi.getTimerCount()).toBe(0);

    await vi.advanceTimersByTimeAsync(5 * 60_000);
    await settle();

    // Still one request, still the same state object shape: a chassis does not
    // change under a live page, and re-probing could flip the transcript
    // component out from under an operator mid-incident.
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    expect(view.current()).toEqual({ kind: "ready", chassis: "legacy", degraded: true });
    view.unmount();
  });
});
