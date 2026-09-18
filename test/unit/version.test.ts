import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { VERSION } from "../../src/version.js";

describe("VERSION", () => {
  it("matches the package.json version", () => {
    const manifest: unknown = JSON.parse(
      readFileSync(new URL("../../package.json", import.meta.url), "utf8"),
    );
    const version =
      typeof manifest === "object" && manifest !== null && "version" in manifest
        ? (manifest as { version: unknown }).version
        : undefined;
    expect(version).toBe(VERSION);
  });
});
