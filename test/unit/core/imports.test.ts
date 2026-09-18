import { readdirSync, readFileSync } from "node:fs";
import { dirname, join, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const CORE_DIR = fileURLToPath(new URL("../../../src/core/", import.meta.url));
const EXPECTED_FILES = [
  "errors.ts",
  "fakeProvider.ts",
  "index.ts",
  "jevClient.ts",
  "tokens.ts",
  "types.ts",
  "windowing.ts",
];
const SPECIFIER_PATTERNS = [
  /\bfrom\s*["']([^"']+)["']/g,
  /\bimport\s*\(\s*["']([^"']+)["']\s*\)/g,
  /\bimport\s+["']([^"']+)["']/g,
  /\brequire\s*\(\s*["']([^"']+)["']\s*\)/g,
];

function listFiles(dir: string): string[] {
  const found: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      found.push(...listFiles(full));
    } else if (entry.name.endsWith(".ts")) {
      found.push(full);
    }
  }
  return found.sort();
}

function specifiersOf(source: string): string[] {
  const found: string[] = [];
  for (const pattern of SPECIFIER_PATTERNS) {
    pattern.lastIndex = 0;
    let match = pattern.exec(source);
    while (match !== null) {
      const specifier = match[1];
      if (specifier !== undefined) {
        found.push(specifier);
      }
      match = pattern.exec(source);
    }
  }
  return found;
}

describe("src/core boundary", () => {
  const files = listFiles(CORE_DIR);

  it("holds exactly the contract files", () => {
    expect(files.map((file) => file.slice(CORE_DIR.length))).toEqual(EXPECTED_FILES);
  });

  it("imports nothing from outside the folder", () => {
    let counted = 0;
    for (const file of files) {
      for (const specifier of specifiersOf(readFileSync(file, "utf8"))) {
        counted += 1;
        if (specifier.startsWith("node:") || specifier === "@typesafe-ai/sdk") {
          continue;
        }
        expect(specifier, `${file} imports ${specifier}`).toMatch(/^\.\.?\//);
        const target = resolve(dirname(file), specifier);
        expect(target.startsWith(CORE_DIR) || `${target}${sep}`.startsWith(CORE_DIR)).toBe(true);
      }
    }
    expect(counted).toBeGreaterThan(5);
  });
});
