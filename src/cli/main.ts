import { realpathSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { JevStageError, UsageError } from "../errors.js";
import { VERSION } from "../version.js";
import { parseCliArgs, usageText } from "./args.js";
import { loadDotEnv } from "./loadEnv.js";

export interface CliIo {
  stdout: (text: string) => void;
  stderr: (text: string) => void;
}

export async function run(argv: readonly string[], io: CliIo): Promise<number> {
  try {
    loadDotEnv(process.cwd());
    const options = parseCliArgs(argv);

    if (options.help) {
      io.stdout(`${usageText()}\n`);
      return 0;
    }
    if (options.version) {
      io.stdout(`${VERSION}\n`);
      return 0;
    }

    throw new UsageError("not implemented yet");
  } catch (error) {
    const { message, exitCode } = toExit(error);
    io.stderr(`${message}\n`);
    return exitCode;
  }
}

export async function main(argv: readonly string[]): Promise<number> {
  return run(argv, {
    stdout: (text) => {
      process.stdout.write(text);
    },
    stderr: (text) => {
      process.stderr.write(text);
    },
  });
}

function toExit(error: unknown): { message: string; exitCode: number } {
  if (error instanceof JevStageError) {
    return { message: `git-jev-stage: ${error.code}: ${error.message}`, exitCode: error.exitCode };
  }
  const detail = error instanceof Error ? error.message : String(error);
  return { message: `git-jev-stage: internal: ${detail}`, exitCode: 1 };
}

function isEntryPoint(): boolean {
  const entry = process.argv[1];
  if (entry === undefined) {
    return false;
  }
  try {
    return pathToFileURL(realpathSync(entry)).href === import.meta.url;
  } catch {
    return false;
  }
}

if (isEntryPoint()) {
  process.exitCode = await main(process.argv.slice(2));
}
