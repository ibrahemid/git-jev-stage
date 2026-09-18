import { readFileSync } from "node:fs";
import { join } from "node:path";

const ENV_LINE = /^([A-Za-z_][A-Za-z0-9_]*)[ \t]*=(.*)$/;

export function loadDotEnv(
  dir: string,
  env: Record<string, string | undefined> = process.env,
): number {
  const contents = readDotEnv(join(dir, ".env"));
  if (contents === undefined) {
    return 0;
  }

  let loaded = 0;
  for (const rawLine of contents.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (line.length === 0 || line.startsWith("#")) {
      continue;
    }
    const match = ENV_LINE.exec(line);
    if (match === null) {
      continue;
    }
    const key = match[1];
    const rawValue = match[2];
    if (key === undefined || rawValue === undefined || env[key] !== undefined) {
      continue;
    }
    env[key] = unquote(rawValue.trim());
    loaded += 1;
  }
  return loaded;
}

function readDotEnv(path: string): string | undefined {
  try {
    return readFileSync(path, "utf8");
  } catch (error) {
    if (isNodeError(error) && (error.code === "ENOENT" || error.code === "EISDIR")) {
      return undefined;
    }
    throw error;
  }
}

function unquote(value: string): string {
  const first = value[0];
  if (value.length >= 2 && (first === '"' || first === "'") && value.endsWith(first)) {
    return value.slice(1, -1);
  }
  return value;
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error;
}
