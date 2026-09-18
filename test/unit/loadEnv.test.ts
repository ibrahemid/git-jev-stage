import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { loadDotEnv } from "../../src/cli/loadEnv.js";

const KEYS = ["JEV_TEST_A", "JEV_TEST_B", "JEV_TEST_C", "JEV_TEST_QUOTED", "JEV_TEST_EMPTY"];

let dir: string;
let saved: Record<string, string | undefined>;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "git-jev-stage-env-"));
  saved = {};
  for (const key of KEYS) {
    saved[key] = process.env[key];
    delete process.env[key];
  }
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
  for (const key of KEYS) {
    const value = saved[key];
    if (value === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = value;
    }
  }
});

function writeDotEnv(contents: string): void {
  writeFileSync(join(dir, ".env"), contents, "utf8");
}

describe("loadDotEnv", () => {
  it("returns 0 when there is no .env", () => {
    expect(loadDotEnv(dir)).toBe(0);
  });

  it("returns 0 when the directory does not exist", () => {
    expect(loadDotEnv(join(dir, "missing"))).toBe(0);
  });

  it("loads KEY=value lines and returns the count", () => {
    writeDotEnv("JEV_TEST_A=one\nJEV_TEST_B=two\n");
    expect(loadDotEnv(dir)).toBe(2);
    expect(process.env.JEV_TEST_A).toBe("one");
    expect(process.env.JEV_TEST_B).toBe("two");
  });

  it("skips comments, blank lines and malformed lines", () => {
    writeDotEnv("# a comment\n\n   \nnot an assignment\n  # indented comment\nJEV_TEST_A=one\n");
    expect(loadDotEnv(dir)).toBe(1);
    expect(process.env.JEV_TEST_A).toBe("one");
  });

  it("strips one layer of surrounding quotes", () => {
    writeDotEnv(`JEV_TEST_A="one two"\nJEV_TEST_B='three'\nJEV_TEST_QUOTED="say \\"hi\\""\n`);
    expect(loadDotEnv(dir)).toBe(3);
    expect(process.env.JEV_TEST_A).toBe("one two");
    expect(process.env.JEV_TEST_B).toBe("three");
    expect(process.env.JEV_TEST_QUOTED).toBe('say \\"hi\\"');
  });

  it("keeps whitespace inside quotes and trims it outside", () => {
    writeDotEnv('JEV_TEST_A="  padded  "\nJEV_TEST_B=  bare  \n');
    expect(loadDotEnv(dir)).toBe(2);
    expect(process.env.JEV_TEST_A).toBe("  padded  ");
    expect(process.env.JEV_TEST_B).toBe("bare");
  });

  it("loads an empty value", () => {
    writeDotEnv("JEV_TEST_EMPTY=\n");
    expect(loadDotEnv(dir)).toBe(1);
    expect(process.env.JEV_TEST_EMPTY).toBe("");
  });

  it("never overrides a key already in the environment", () => {
    process.env.JEV_TEST_A = "from-shell";
    process.env.JEV_TEST_EMPTY = "";
    writeDotEnv("JEV_TEST_A=from-file\nJEV_TEST_EMPTY=from-file\nJEV_TEST_B=from-file\n");
    expect(loadDotEnv(dir)).toBe(1);
    expect(process.env.JEV_TEST_A).toBe("from-shell");
    expect(process.env.JEV_TEST_EMPTY).toBe("");
    expect(process.env.JEV_TEST_B).toBe("from-file");
  });

  it("reads CRLF files", () => {
    writeDotEnv("JEV_TEST_A=one\r\nJEV_TEST_B=two\r\n");
    expect(loadDotEnv(dir)).toBe(2);
    expect(process.env.JEV_TEST_A).toBe("one");
    expect(process.env.JEV_TEST_B).toBe("two");
  });

  it("ignores keys that are not valid identifiers", () => {
    writeDotEnv("1BAD=x\nJEV-TEST=x\nJEV_TEST_A=one\n");
    expect(loadDotEnv(dir)).toBe(1);
    expect(process.env.JEV_TEST_A).toBe("one");
  });
});
