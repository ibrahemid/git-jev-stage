import { describe, expect, it } from "vitest";
import {
  type ClassifyRequest,
  DEFAULT_PER_QUESTION_TOKENS,
  estimateTokens,
  FakeProvider,
  type JevProvider,
  ProviderError,
} from "../../../src/core/index.js";
import {
  BASE_INSTRUCTIONS,
  classifyHunks,
  EXCLUDE_INSTRUCTIONS,
  envelopeTokens,
  HUNK_OPTIONS,
} from "../../../src/selection/classify.js";
import { DEFAULT_THRESHOLD } from "../../../src/selection/policy.js";
import type { Snapshot } from "../../../src/types.js";
import { answer } from "../../helpers/demo.js";
import { hunksOf, SAMPLE_DIFF, snapshotFromDiff } from "../../helpers/plan.js";

const INTENT = "the auth fix";

function bigDiff(bodyLines: number): string {
  const body = Array.from({ length: bodyLines }, (_, index) => `+const value${index} = ${index};`);
  return [
    "diff --git a/src/auth/login.ts b/src/auth/login.ts",
    "index 1111111111111111111111111111111111111111..2222222222222222222222222222222222222222 100644",
    "--- a/src/auth/login.ts",
    "+++ b/src/auth/login.ts",
    `@@ -1,1 +1,${bodyLines + 1} @@`,
    " const a = 1;",
    ...body,
    "@@ -10,3 +11,3 @@ function tail() {",
    '-  log("old");',
    '+  log("new");',
    "   return 1;",
    "diff --git a/src/styles/app.css b/src/styles/app.css",
    "index 3333333333333333333333333333333333333333..4444444444444444444444444444444444444444 100644",
    "--- a/src/styles/app.css",
    "+++ b/src/styles/app.css",
    "@@ -1,2 +1,2 @@",
    "-.btn { padding: 4px; }",
    "+.btn { padding: 6px; }",
    " .card { margin: 8px; }",
    "",
  ].join("\n");
}

function askCosts(snapshot: Snapshot): number[] {
  return hunksOf(snapshot).map((hunk) => estimateTokens(hunk.text) + DEFAULT_PER_QUESTION_TOKENS);
}

function includeEverything(snapshot: Snapshot): FakeProvider {
  const answers = Object.fromEntries(
    hunksOf(snapshot).map((hunk) => [hunk.id, answer("include", 0.9)]),
  );
  return new FakeProvider({ answers });
}

function stateOf(request: ClassifyRequest): Record<string, unknown> {
  return request.state as Record<string, unknown>;
}

function onlyRequest(provider: FakeProvider): ClassifyRequest {
  const request = provider.requests[0];
  if (request === undefined) {
    throw new Error("the provider was never called");
  }
  return request;
}

describe("classifyHunks state", () => {
  it("sends the intent, the instructions and every hunk as an ask", async () => {
    const snapshot = snapshotFromDiff(SAMPLE_DIFF);
    const provider = includeEverything(snapshot);

    await classifyHunks({ snapshot, intent: INTENT, threshold: DEFAULT_THRESHOLD, provider });

    expect(provider.requests).toHaveLength(1);
    expect(stateOf(onlyRequest(provider))).toEqual({
      intent: INTENT,
      instructions: BASE_INSTRUCTIONS,
      files: [
        {
          path: "src/auth/login.ts",
          hunks: [
            {
              id: hunksOf(snapshot)[0]?.id,
              header: hunksOf(snapshot)[0]?.header,
              patch: hunksOf(snapshot)[0]?.text,
              role: "ask",
            },
            {
              id: hunksOf(snapshot)[1]?.id,
              header: hunksOf(snapshot)[1]?.header,
              patch: hunksOf(snapshot)[1]?.text,
              role: "ask",
            },
          ],
        },
        {
          path: "src/styles/app.css",
          hunks: [
            {
              id: hunksOf(snapshot)[2]?.id,
              header: hunksOf(snapshot)[2]?.header,
              patch: hunksOf(snapshot)[2]?.text,
              role: "ask",
            },
          ],
        },
      ],
    });
  });

  it("asks one choice question per hunk with the contract wording", async () => {
    const snapshot = snapshotFromDiff(SAMPLE_DIFF);
    const provider = includeEverything(snapshot);

    await classifyHunks({ snapshot, intent: INTENT, threshold: DEFAULT_THRESHOLD, provider });

    const questions = onlyRequest(provider).questions;
    expect(Object.keys(questions)).toEqual(hunksOf(snapshot).map((hunk) => hunk.id));
    for (const hunk of hunksOf(snapshot)) {
      expect(questions[hunk.id]).toEqual({
        instructions: `Does hunk ${hunk.id} belong to the described change?`,
        options: {
          include: "every changed line in this hunk belongs to the described change",
          exclude: "no changed line in this hunk belongs to the described change",
          mixed: "some changed lines belong and some do not",
        },
      });
    }
    expect(HUNK_OPTIONS.mixed).toBe("some changed lines belong and some do not");
  });

  it("adds the exclude sentence and the exclude text when one is given", async () => {
    const snapshot = snapshotFromDiff(SAMPLE_DIFF);
    const provider = includeEverything(snapshot);

    await classifyHunks({
      snapshot,
      intent: INTENT,
      exclude: "logging",
      threshold: DEFAULT_THRESHOLD,
      provider,
    });

    const state = stateOf(onlyRequest(provider));
    expect(state.exclude).toBe("logging");
    expect(state.instructions).toBe(`${BASE_INSTRUCTIONS}${EXCLUDE_INSTRUCTIONS}`);
    expect(EXCLUDE_INSTRUCTIONS).toBe(" Lines that match exclude never belong.");
  });
});

describe("classifyHunks windows", () => {
  it("splits into windows and marks the neighbour hunk as context", async () => {
    const snapshot = snapshotFromDiff(SAMPLE_DIFF);
    const provider = includeEverything(snapshot);
    const shared = envelopeTokens(INTENT);
    const costs = askCosts(snapshot);
    const [first, second, third] = costs;
    expect(first).toBeDefined();
    expect(second).toBeDefined();
    expect(third).toBeDefined();
    if (first === undefined || second === undefined || third === undefined) {
      return;
    }
    const tokenCeiling = shared + first + (second - DEFAULT_PER_QUESTION_TOKENS);
    expect(shared + first + second).toBeGreaterThan(tokenCeiling);

    const { decisions } = await classifyHunks({
      snapshot,
      intent: INTENT,
      threshold: DEFAULT_THRESHOLD,
      provider,
      tokenCeiling,
    });

    expect(provider.requests.length).toBeGreaterThan(1);
    const roles = provider.requests.map((request) => {
      const files = stateOf(request).files as Array<{ hunks: Array<{ id: string; role: string }> }>;
      return files.flatMap((file) => file.hunks).map((hunk) => `${hunk.id}:${hunk.role}`);
    });
    const hunks = hunksOf(snapshot);
    expect(roles[0]).toEqual([`${hunks[0]?.id}:ask`, `${hunks[1]?.id}:context`]);
    expect(roles[1]).toEqual([`${hunks[0]?.id}:context`, `${hunks[1]?.id}:ask`]);
    for (const hunk of hunks) {
      expect(decisions.get(hunk.id)).toMatchObject({ decision: "include", source: "model" });
    }
  });

  it("marks a hunk that cannot fit the ceiling as mixed without asking", async () => {
    const snapshot = snapshotFromDiff(bigDiff(400));
    const provider = includeEverything(snapshot);
    const shared = envelopeTokens(INTENT);
    const costs = askCosts(snapshot);
    const [oversize, second, third] = costs;
    if (oversize === undefined || second === undefined || third === undefined) {
      throw new Error("the fixture must have three hunks");
    }
    const tokenCeiling = shared + second + third;
    expect(shared + oversize).toBeGreaterThan(tokenCeiling);

    const { decisions, usage } = await classifyHunks({
      snapshot,
      intent: INTENT,
      threshold: DEFAULT_THRESHOLD,
      provider,
      tokenCeiling,
    });

    const hunks = hunksOf(snapshot);
    expect(decisions.get(hunks[0]?.id ?? "")).toEqual({
      hunkId: hunks[0]?.id,
      decision: "mixed",
      source: "too-large",
    });
    expect(decisions.get(hunks[1]?.id ?? "")).toMatchObject({ decision: "include" });
    expect(decisions.get(hunks[2]?.id ?? "")).toMatchObject({ decision: "include" });
    expect(usage.requests).toBe(1);
    const asked = provider.requests.flatMap((request) => Object.keys(request.questions));
    expect(asked).not.toContain(hunks[0]?.id);
  });
});

describe("classifyHunks results", () => {
  it("adds up the usage of every window and reports missing answers", async () => {
    const snapshot = snapshotFromDiff(SAMPLE_DIFF);
    const shared = envelopeTokens(INTENT);
    const tokenCeiling = shared + Math.max(...askCosts(snapshot));
    const provider: JevProvider = {
      classify: () =>
        Promise.resolve({
          outcomes: {},
          usage: { inputTokens: 7, outputTokens: 3 },
          model: "stub",
        }),
    };

    const { decisions, usage } = await classifyHunks({
      snapshot,
      intent: INTENT,
      threshold: DEFAULT_THRESHOLD,
      provider,
      tokenCeiling,
    });

    expect(usage).toEqual({ requests: 3, inputTokens: 21, outputTokens: 9 });
    for (const hunk of hunksOf(snapshot)) {
      expect(decisions.get(hunk.id)).toEqual({
        hunkId: hunk.id,
        decision: "mixed",
        source: "missing",
      });
    }
  });

  it("lets a provider error through", async () => {
    const snapshot = snapshotFromDiff(SAMPLE_DIFF);
    const provider = new FakeProvider({
      error: new ProviderError("TypeSafe request failed (503)"),
    });

    await expect(
      classifyHunks({ snapshot, intent: INTENT, threshold: DEFAULT_THRESHOLD, provider }),
    ).rejects.toBeInstanceOf(ProviderError);
  });
});
