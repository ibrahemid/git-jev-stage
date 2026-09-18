import { describe, expect, it } from "vitest";
import { renderPatch, renderPlan, shouldColor } from "../../../src/cli/render.js";
import type { HunkDecision } from "../../../src/types.js";
import {
  decisionsOf,
  hunkAt,
  makePlan,
  SAMPLE_DIFF,
  snapshotFromDiff,
} from "../../helpers/plan.js";

function sample(): { snapshot: ReturnType<typeof snapshotFromDiff>; ids: string[] } {
  const snapshot = snapshotFromDiff(SAMPLE_DIFF);
  return { snapshot, ids: [0, 1, 2].map((index) => hunkAt(snapshot, index).id) };
}

function classified(ids: readonly string[]): HunkDecision[] {
  const [auth, tail, css] = ids;
  if (auth === undefined || tail === undefined || css === undefined) {
    throw new Error("the sample diff must have three hunks");
  }
  return [
    {
      hunkId: auth,
      decision: "include",
      source: "model",
      confidence: 0.94,
      probabilities: { include: 0.94, exclude: 0.04, mixed: 0.02 },
    },
    {
      hunkId: tail,
      decision: "exclude",
      source: "model",
      confidence: 0.95,
      probabilities: { include: 0.02, exclude: 0.95, mixed: 0.03 },
    },
    {
      hunkId: css,
      decision: "mixed",
      source: "low-confidence",
      confidence: 0.4,
      probabilities: { include: 0.4, exclude: 0.2, mixed: 0.4 },
    },
  ];
}

describe("renderPlan", () => {
  it("prints one line per file and per hunk with the probabilities", () => {
    const { snapshot, ids } = sample();
    snapshot.skipped.push({ path: "docs/notes.md", reason: "mode-only" });
    const plan = makePlan(snapshot, decisionsOf(classified(ids)));
    const [auth, tail, css] = ids.map((id) => id.slice(0, 8));

    const output = renderPlan({ plan, includeIds: new Set([ids[0] ?? ""]), color: false });

    expect(output).toBe(
      [
        "M src/auth/login.ts",
        `  + ${auth} @@ -1,3 +1,4 @@  include 0.94  exclude 0.04  mixed 0.02`,
        `  - ${tail} @@ -10,3 +11,3 @@ function tail() {  include 0.02  exclude 0.95  mixed 0.03`,
        "M src/styles/app.css",
        `  ? ${css} @@ -1,2 +1,2 @@  include 0.40  exclude 0.20  mixed 0.40  low-confidence`,
        "skipped: docs/notes.md (mode-only)",
        "these changes cannot be staged by hunk; stage them with git add",
        "will stage: 1 hunk, 1 file (+1 -0)",
        "",
      ].join("\n"),
    );
  });

  it("prints the source alone when the model was not asked", () => {
    const { snapshot, ids } = sample();
    const plan = makePlan(
      snapshot,
      decisionsOf(ids.map((hunkId) => ({ hunkId, decision: "mixed", source: "no-provider" }))),
    );

    const output = renderPlan({ plan, includeIds: new Set(), color: false });

    expect(output).toContain(`  ? ${ids[0]?.slice(0, 8)} @@ -1,3 +1,4 @@  no-provider`);
    expect(output).toContain("will stage: 0 hunks, 0 files (+0 -0)");
  });

  it("colors the marks when colors are on", () => {
    const { snapshot, ids } = sample();
    const plan = makePlan(snapshot, decisionsOf(classified(ids)));

    const output = renderPlan({ plan, includeIds: new Set([ids[0] ?? ""]), color: true });

    expect(output).toContain(`  [32m+[0m ${ids[0]?.slice(0, 8)} `);
    expect(output).toContain(`  [2m[31m-[0m ${ids[1]?.slice(0, 8)} `);
    expect(output).toContain(`  [33m?[0m ${ids[2]?.slice(0, 8)} `);
    expect(output).not.toContain("[32mM");
  });
});

describe("shouldColor", () => {
  it("needs a tty, a request and no NO_COLOR", () => {
    expect(shouldColor({ requested: true, isTty: true, noColor: undefined })).toBe(true);
    expect(shouldColor({ requested: true, isTty: true, noColor: "" })).toBe(true);
    expect(shouldColor({ requested: true, isTty: true, noColor: "1" })).toBe(false);
    expect(shouldColor({ requested: true, isTty: false, noColor: undefined })).toBe(false);
    expect(shouldColor({ requested: false, isTty: true, noColor: undefined })).toBe(false);
  });
});

describe("renderPatch", () => {
  it("writes the patch bytes as they are", () => {
    const written: Buffer[] = [];
    const patch = Buffer.from("@@ -1,2 +1,2 @@\n-a\n+b\n", "utf8");

    renderPatch(patch, (bytes) => written.push(bytes));

    expect(Buffer.concat(written).equals(patch)).toBe(true);
  });

  it("writes nothing for an empty patch", () => {
    const written: Buffer[] = [];

    renderPatch(Buffer.alloc(0), (bytes) => written.push(bytes));

    expect(written).toHaveLength(0);
  });
});
