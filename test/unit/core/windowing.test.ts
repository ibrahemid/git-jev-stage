import { describe, expect, it } from "vitest";
import type { Window, WindowItem } from "../../../src/core/index.js";
import { buildWindows, runWindows } from "../../../src/core/index.js";

const BUDGET = { tokenCeiling: 100, sharedTokens: 10, perQuestionTokens: 5 } as const;

function item(id: string, tokens: number, group = "a", ordinal = 0): WindowItem {
  return { id, text: "x".repeat(tokens * 4), group, ordinal };
}

function fileItems(group: string, ids: readonly string[], tokens: number): WindowItem[] {
  return ids.map((id, ordinal) => item(id, tokens, group, ordinal));
}

function windowStub(askIds: string[]): Window {
  return { askIds, contextIds: [], estimatedTokens: 0 };
}

describe("buildWindows", () => {
  it("fills windows up to the ceiling and keeps item order", () => {
    const items = fileItems("a", ["h1", "h2", "h3", "h4"], 25);
    const windows = buildWindows(items, { ...BUDGET, neighborContext: false });

    expect(windows).toEqual([
      { askIds: ["h1", "h2", "h3"], contextIds: [], estimatedTokens: 100 },
      { askIds: ["h4"], contextIds: [], estimatedTokens: 40 },
    ]);
  });

  it("is deterministic and covers every item exactly once", () => {
    const items = [
      ...fileItems("a", ["a1", "a2", "a3"], 17),
      ...fileItems("b", ["b1", "b2"], 23),
      ...fileItems("c", ["c1"], 9),
    ];
    const first = buildWindows(items, BUDGET);
    const second = buildWindows(items, BUDGET);

    expect(second).toEqual(first);
    expect(first.flatMap((window) => window.askIds)).toEqual(items.map((entry) => entry.id));
  });

  it("adds a neighbor of the same group as context when it fits", () => {
    const items = fileItems("a", ["h1", "h2", "h3", "h4"], 25);
    const windows = buildWindows(items, BUDGET);

    expect(windows).toEqual([
      { askIds: ["h1", "h2", "h3"], contextIds: [], estimatedTokens: 100 },
      { askIds: ["h4"], contextIds: ["h3"], estimatedTokens: 65 },
    ]);
  });

  it("omits context that does not fit and never splits for it", () => {
    const items = [...fileItems("a", ["h1", "h2"], 25), item("h3", 70, "a", 2)];
    const windows = buildWindows(items, BUDGET);

    expect(windows).toEqual([
      { askIds: ["h1", "h2"], contextIds: [], estimatedTokens: 70 },
      { askIds: ["h3"], contextIds: [], estimatedTokens: 85 },
    ]);
  });

  it("skips context when neighborContext is off", () => {
    const items = fileItems("a", ["h1", "h2", "h3", "h4"], 25);
    const withContext = buildWindows(items, BUDGET);
    const withoutContext = buildWindows(items, { ...BUDGET, neighborContext: false });

    expect(withContext[1]?.contextIds).toEqual(["h3"]);
    expect(withoutContext[1]?.contextIds).toEqual([]);
    expect(withoutContext[1]?.estimatedTokens).toBe(40);
  });

  it("never takes context from another group", () => {
    const items = [item("a1", 50, "a", 0), item("b1", 5, "b", 0)];
    const windows = buildWindows(items, { ...BUDGET, tokenCeiling: 70 });

    expect(windows).toEqual([
      { askIds: ["a1"], contextIds: [], estimatedTokens: 65 },
      { askIds: ["b1"], contextIds: [], estimatedTokens: 20 },
    ]);
  });

  it("isolates an item that does not fit on its own", () => {
    const items = [
      item("small1", 10, "a", 0),
      item("big", 200, "a", 1),
      item("small2", 10, "a", 2),
    ];
    const windows = buildWindows(items, BUDGET);

    expect(windows.map((window) => window.askIds)).toEqual([["small1"], ["big"], ["small2"]]);
    expect(windows[1]?.estimatedTokens).toBe(215);
    expect(windows[1]?.estimatedTokens).toBeGreaterThan(BUDGET.tokenCeiling);
    expect(windows[1]?.contextIds).toEqual([]);
  });

  it("returns no windows for no items", () => {
    expect(buildWindows([], BUDGET)).toEqual([]);
  });
});

describe("runWindows", () => {
  it("keeps results in window order", async () => {
    const windows = ["w0", "w1", "w2", "w3", "w4", "w5"].map((id) => windowStub([id]));
    const results = await runWindows(
      windows,
      async (window, index) => {
        await new Promise((resolve) => setTimeout(resolve, (windows.length - index) * 2));
        return `${window.askIds[0]}:${index}`;
      },
      { concurrency: 3 },
    );

    expect(results).toEqual(["w0:0", "w1:1", "w2:2", "w3:3", "w4:4", "w5:5"]);
  });

  it("never exceeds the concurrency cap and reaches it", async () => {
    const windows = Array.from({ length: 9 }, (_, index) => windowStub([`w${index}`]));
    let inFlight = 0;
    let maxInFlight = 0;

    await runWindows(
      windows,
      async () => {
        inFlight += 1;
        maxInFlight = Math.max(maxInFlight, inFlight);
        await new Promise((resolve) => setTimeout(resolve, 5));
        inFlight -= 1;
      },
      { concurrency: 3 },
    );

    expect(maxInFlight).toBe(3);
  });

  it("defaults to four in flight", async () => {
    const windows = Array.from({ length: 12 }, (_, index) => windowStub([`w${index}`]));
    let inFlight = 0;
    let maxInFlight = 0;

    await runWindows(windows, async () => {
      inFlight += 1;
      maxInFlight = Math.max(maxInFlight, inFlight);
      await new Promise((resolve) => setTimeout(resolve, 5));
      inFlight -= 1;
    });

    expect(maxInFlight).toBe(4);
  });

  it("fails fast and starts no further windows", async () => {
    const windows = Array.from({ length: 4 }, (_, index) => windowStub([`w${index}`]));
    const started: number[] = [];
    const failure = new Error("window 1 failed");

    await expect(
      runWindows(
        windows,
        async (_window, index) => {
          started.push(index);
          if (index === 1) {
            throw failure;
          }
          return index;
        },
        { concurrency: 1 },
      ),
    ).rejects.toBe(failure);

    expect(started).toEqual([0, 1]);
  });

  it("aborts the windows still in flight", async () => {
    const windows = [windowStub(["w0"]), windowStub(["w1"])];
    let aborted = false;
    const failure = new Error("first failed");

    await expect(
      runWindows(
        windows,
        async (_window, index, signal) => {
          if (index === 0) {
            throw failure;
          }
          await new Promise<void>((resolve) => {
            signal.addEventListener(
              "abort",
              () => {
                aborted = true;
                resolve();
              },
              { once: true },
            );
          });
          return index;
        },
        { concurrency: 2 },
      ),
    ).rejects.toBe(failure);

    expect(aborted).toBe(true);
  });

  it("stops when the caller signal is already aborted", async () => {
    const controller = new AbortController();
    controller.abort();

    await expect(
      runWindows([windowStub(["w0"])], async () => 1, { signal: controller.signal }),
    ).rejects.toThrow();
  });

  it("returns nothing for no windows", async () => {
    expect(await runWindows([], async () => 1)).toEqual([]);
  });
});
