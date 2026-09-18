import { describe, expect, it } from "vitest";
import { buildJsonDocument, renderJsonDocument } from "../../../src/cli/json.js";
import type { HunkDecision } from "../../../src/types.js";
import { VERSION } from "../../../src/version.js";
import {
  decisionsOf,
  hunkAt,
  makePlan,
  SAMPLE_DIFF,
  snapshotFromDiff,
} from "../../helpers/plan.js";

function planWith(decisions: HunkDecision[], exclude?: string) {
  const snapshot = snapshotFromDiff(SAMPLE_DIFF);
  snapshot.skipped.push({ path: "docs/notes.md", reason: "mode-only" });
  return makePlan(snapshot, decisionsOf(decisions), exclude === undefined ? {} : { exclude });
}

describe("buildJsonDocument", () => {
  it("describes the plan, its hunks and what was staged", () => {
    const snapshot = snapshotFromDiff(SAMPLE_DIFF);
    const auth = hunkAt(snapshot, 0);
    const css = hunkAt(snapshot, 2);
    const plan = planWith([
      {
        hunkId: auth.id,
        decision: "include",
        source: "model",
        confidence: 0.94,
        probabilities: { include: 0.94, exclude: 0.04, mixed: 0.02 },
      },
      { hunkId: hunkAt(snapshot, 1).id, decision: "mixed", source: "missing" },
      { hunkId: css.id, decision: "exclude", source: "model", confidence: 0.9 },
    ]);

    const document = buildJsonDocument({
      plan,
      applied: true,
      stagedHunkIds: [auth.id],
      mixedHunkIds: [hunkAt(snapshot, 1).id],
    });

    expect(document.version).toBe(VERSION);
    expect(document.intent).toBe("the auth fix");
    expect(document.exclude).toBeUndefined();
    expect(document.threshold).toBe(0.6);
    expect(document.head).toBe(plan.snapshot.headOid);
    expect(document.indexHash).toBe(plan.snapshot.indexHash);
    expect(document.diffHash).toBe(plan.snapshot.diffHash);
    expect(document.skipped).toEqual([{ path: "docs/notes.md", reason: "mode-only" }]);
    expect(document.usage).toEqual(plan.usage);
    expect(document.applied).toBe(true);
    expect(document.stagedHunkIds).toEqual([auth.id]);
    expect(document.mixedHunkIds).toEqual([hunkAt(snapshot, 1).id]);
    expect(document.files.map((file) => file.path)).toEqual([
      "src/auth/login.ts",
      "src/styles/app.css",
    ]);
    expect(document.files[0]?.kind).toBe("modified");
    expect(document.files[0]?.hunks[0]).toEqual({
      id: auth.id,
      header: auth.header,
      text: auth.text,
      added: auth.added,
      removed: auth.removed,
      decision: "include",
      source: "model",
      confidence: 0.94,
      probabilities: { include: 0.94, exclude: 0.04, mixed: 0.02 },
    });
  });

  it("leaves out confidence and probabilities when the model did not answer", () => {
    const snapshot = snapshotFromDiff(SAMPLE_DIFF);
    const plan = planWith([
      { hunkId: hunkAt(snapshot, 0).id, decision: "mixed", source: "missing" },
    ]);

    const hunk = buildJsonDocument({
      plan,
      applied: false,
      stagedHunkIds: [],
      mixedHunkIds: [],
    }).files[0]?.hunks[0];

    expect(hunk).toBeDefined();
    expect(hunk && "confidence" in hunk).toBe(false);
    expect(hunk && "probabilities" in hunk).toBe(false);
    expect(hunk?.source).toBe("missing");
  });

  it("keeps the exclude sentence when one was given", () => {
    const document = buildJsonDocument({
      plan: planWith([], "logging"),
      applied: false,
      stagedHunkIds: [],
      mixedHunkIds: [],
    });

    expect(document.exclude).toBe("logging");
  });
});

describe("renderJsonDocument", () => {
  it("prints one indented document ending with a newline", () => {
    const text = renderJsonDocument({
      plan: planWith([]),
      applied: false,
      stagedHunkIds: [],
      mixedHunkIds: [],
    });

    expect(text.endsWith("}\n")).toBe(true);
    expect(text).toContain('\n  "version": ');
    expect(JSON.parse(text)).toMatchObject({ applied: false, threshold: 0.6 });
  });
});
