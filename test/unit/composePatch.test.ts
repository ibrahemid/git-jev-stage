import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { UnknownHunkError } from "../../src/errors.js";
import { composePatch, summarizeSelection } from "../../src/git/composePatch.js";
import { parseUnifiedDiff } from "../../src/git/parseDiff.js";
import type { DiffFile, Hunk } from "../../src/types.js";

const FIXTURE_DIR = join(import.meta.dirname, "..", "fixtures");

const WHOLE_FILE_FIXTURES = [
  "added-file.diff",
  "crlf.diff",
  "deleted-file.diff",
  "modified-multi-hunk.diff",
  "no-newline-eof.diff",
  "quoted-names.diff",
  "twin-hunks.diff",
];

function fixtureBytes(name: string): Buffer {
  return readFileSync(join(FIXTURE_DIR, name));
}

function parseFixture(name: string): DiffFile[] {
  return parseUnifiedDiff(fixtureBytes(name));
}

function fileByPath(files: readonly DiffFile[], path: string): DiffFile {
  const file = files.find((candidate) => candidate.path === path);
  if (file === undefined) {
    throw new Error(`no file for ${path}`);
  }
  return file;
}

function hunkAt(files: readonly DiffFile[], path: string, ordinal: number): Hunk {
  const hunk = fileByPath(files, path).hunks[ordinal];
  if (hunk === undefined) {
    throw new Error(`no hunk ${ordinal} for ${path}`);
  }
  return hunk;
}

function allIds(files: readonly DiffFile[]): string[] {
  return files.flatMap((file) => file.hunks.map((hunk) => hunk.id));
}

describe("composePatch", () => {
  it("emits the file header followed by only the selected hunk bytes", () => {
    const files = parseFixture("modified-multi-hunk.diff");
    const file = fileByPath(files, "src/app.ts");
    const second = hunkAt(files, "src/app.ts", 1);

    const patch = composePatch(files, new Set([second.id]));

    expect(patch.equals(Buffer.concat([file.headerBytes, second.bytes]))).toBe(true);
    expect(patch.includes(Buffer.from('+import { c } from "./c.js";'))).toBe(false);
  });

  it("keeps the original hunk order regardless of selection order", () => {
    const files = parseFixture("modified-multi-hunk.diff");
    const first = hunkAt(files, "src/app.ts", 0);
    const second = hunkAt(files, "src/app.ts", 1);

    const patch = composePatch(files, new Set([second.id, first.id]));

    expect(patch.equals(fixtureBytes("modified-multi-hunk.diff"))).toBe(true);
  });

  it("omits files without a selected hunk", () => {
    const files = parseFixture("twin-hunks.diff");
    const two = fileByPath(files, "src/two.ts");
    const hunk = hunkAt(files, "src/two.ts", 0);

    const patch = composePatch(files, new Set([hunk.id]));

    expect(patch.equals(Buffer.concat([two.headerBytes, hunk.bytes]))).toBe(true);
    expect(patch.includes(Buffer.from("src/one.ts"))).toBe(false);
  });

  it("returns an empty patch when nothing is selected", () => {
    const files = parseFixture("twin-hunks.diff");

    expect(composePatch(files, new Set())).toHaveLength(0);
    expect(composePatch([], new Set())).toHaveLength(0);
  });

  it.each(WHOLE_FILE_FIXTURES)("reproduces %s when every hunk is selected", (name) => {
    const files = parseFixture(name);

    expect(composePatch(files, new Set(allIds(files))).equals(fixtureBytes(name))).toBe(true);
  });

  it("rejects ids that match no hunk", () => {
    const files = parseFixture("twin-hunks.diff");
    const known = hunkAt(files, "src/one.ts", 0);

    const error = (() => {
      try {
        composePatch(files, new Set(["ffffffffffffffff", known.id, "0000000000000000"]));
        return undefined;
      } catch (reason: unknown) {
        return reason;
      }
    })();

    expect(error).toBeInstanceOf(UnknownHunkError);
    if (error instanceof UnknownHunkError) {
      expect(error.ids).toEqual(["0000000000000000", "ffffffffffffffff"]);
      expect(error.code).toBe("unknown-hunk");
      expect(error.message).not.toContain("const value");
    }
  });
});

describe("summarizeSelection", () => {
  it("counts selected hunks, files and lines", () => {
    const files = [...parseFixture("modified-multi-hunk.diff"), ...parseFixture("crlf.diff")];
    const first = hunkAt(files, "src/app.ts", 0);
    const second = hunkAt(files, "src/app.ts", 1);
    const crlf = hunkAt(files, "src/crlf.ts", 0);

    const summary = summarizeSelection(files, new Set([first.id, second.id, crlf.id]));

    expect(summary).toEqual({
      files: 2,
      hunks: 3,
      added: 4,
      removed: 3,
      perFile: [
        { path: "src/app.ts", hunks: 2, added: 3, removed: 2 },
        { path: "src/crlf.ts", hunks: 1, added: 1, removed: 1 },
      ],
    });
  });

  it("reports only the files that contribute a selected hunk", () => {
    const files = parseFixture("twin-hunks.diff");
    const hunk = hunkAt(files, "src/two.ts", 0);

    expect(summarizeSelection(files, new Set([hunk.id]))).toEqual({
      files: 1,
      hunks: 1,
      added: 1,
      removed: 1,
      perFile: [{ path: "src/two.ts", hunks: 1, added: 1, removed: 1 }],
    });
  });

  it("returns zero counts for an empty selection", () => {
    expect(summarizeSelection(parseFixture("twin-hunks.diff"), new Set())).toEqual({
      files: 0,
      hunks: 0,
      added: 0,
      removed: 0,
      perFile: [],
    });
  });

  it("rejects ids that match no hunk", () => {
    const files = parseFixture("twin-hunks.diff");

    expect(() => summarizeSelection(files, new Set(["ffffffffffffffff"]))).toThrow(
      UnknownHunkError,
    );
  });
});
