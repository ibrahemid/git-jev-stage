import { describe, expect, it } from "vitest";
import { DEFAULT_THRESHOLD, parseCliArgs, usageText } from "../../src/cli/args.js";
import { UsageError } from "../../src/errors.js";

describe("parseCliArgs", () => {
  it("returns the intent and the defaults", () => {
    const options = parseCliArgs(["move auth to the new session store"]);
    expect(options).toEqual({
      intent: "move auth to the new session store",
      dryRun: false,
      yes: false,
      json: false,
      threshold: DEFAULT_THRESHOLD,
      color: true,
      help: false,
      version: false,
    });
    expect("exclude" in options).toBe(false);
  });

  it("reads every flag", () => {
    const options = parseCliArgs([
      "fix login",
      "--exclude",
      "css tweaks",
      "--dry-run",
      "--yes",
      "--json",
      "--no-color",
      "--threshold",
      "0.9",
    ]);
    expect(options).toEqual({
      intent: "fix login",
      exclude: "css tweaks",
      dryRun: true,
      yes: true,
      json: true,
      threshold: 0.9,
      color: false,
      help: false,
      version: false,
    });
  });

  it("accepts --flag=value form", () => {
    const options = parseCliArgs(["fix login", "--threshold=0.25", "--exclude=logging"]);
    expect(options.threshold).toBe(0.25);
    expect(options.exclude).toBe("logging");
  });

  it("does not require an intent for --help", () => {
    const options = parseCliArgs(["--help"]);
    expect(options.help).toBe(true);
    expect(options.intent).toBe("");
  });

  it("does not require an intent for --version", () => {
    const options = parseCliArgs(["--version"]);
    expect(options.version).toBe(true);
  });

  it("accepts a threshold of exactly 1", () => {
    expect(parseCliArgs(["x", "--threshold", "1"]).threshold).toBe(1);
  });

  it.each(["0", "-0.5", "1.0001", "2", "abc", "", "NaN", "Infinity", "0.5x"])(
    "rejects the threshold %j",
    (value) => {
      expect(() => parseCliArgs(["x", "--threshold", value])).toThrow(UsageError);
    },
  );

  it("reports the offending threshold", () => {
    expect(() => parseCliArgs(["x", "--threshold", "7"])).toThrow(
      /--threshold must be greater than 0 and at most 1, got 7/,
    );
  });

  it("rejects an unknown flag", () => {
    expect(() => parseCliArgs(["x", "--bogus"])).toThrow(UsageError);
  });

  it("rejects a missing intent", () => {
    expect(() => parseCliArgs([])).toThrow(UsageError);
    expect(() => parseCliArgs(["--yes"])).toThrow(/missing sentence/);
  });

  it("rejects an empty intent", () => {
    expect(() => parseCliArgs(["   "])).toThrow(/the sentence is empty/);
  });

  it("rejects more than one positional", () => {
    expect(() => parseCliArgs(["fix", "login"])).toThrow(/quote the whole sentence/);
  });

  it("rejects an empty --exclude", () => {
    expect(() => parseCliArgs(["fix login", "--exclude", " "])).toThrow(/--exclude is empty/);
  });

  it("rejects a value-less --exclude", () => {
    expect(() => parseCliArgs(["fix login", "--exclude"])).toThrow(UsageError);
  });

  it("throws UsageError with exit code 2", () => {
    try {
      parseCliArgs(["x", "--bogus"]);
      expect.unreachable();
    } catch (error) {
      expect(error).toBeInstanceOf(UsageError);
      expect((error as UsageError).exitCode).toBe(2);
      expect((error as UsageError).code).toBe("usage");
      expect((error as UsageError).name).toBe("UsageError");
    }
  });
});

describe("usageText", () => {
  it("names the command and every flag", () => {
    const text = usageText();
    expect(text).toContain("git jev-stage");
    for (const flag of [
      "--exclude",
      "--threshold",
      "--dry-run",
      "--yes",
      "--json",
      "--no-color",
      "--help",
      "--version",
    ]) {
      expect(text).toContain(flag);
    }
  });
});
