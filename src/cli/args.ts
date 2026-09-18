import { parseArgs } from "node:util";
import { UsageError } from "../errors.js";

export interface CliOptions {
  intent: string;
  exclude?: string;
  dryRun: boolean;
  yes: boolean;
  json: boolean;
  threshold: number;
  color: boolean;
  help: boolean;
  version: boolean;
}

export const DEFAULT_THRESHOLD = 0.6;

const PARSE_CONFIG = {
  allowPositionals: true,
  strict: true,
  options: {
    exclude: { type: "string" },
    "dry-run": { type: "boolean" },
    yes: { type: "boolean" },
    json: { type: "boolean" },
    threshold: { type: "string" },
    "no-color": { type: "boolean" },
    help: { type: "boolean" },
    version: { type: "boolean" },
  },
} as const;

export function usageText(): string {
  return [
    'usage: git jev-stage "<sentence>" [options]',
    "",
    "Stages the unstaged hunks that match the sentence.",
    "",
    "options:",
    '  --exclude "<sentence>"  never stage hunks that match this sentence',
    "  --threshold <n>         confidence needed to stage or skip a hunk, 0-1 (default 0.6)",
    "  --dry-run               print the plan and the composed patch, stage nothing",
    "  --yes                   skip prompts and leave mixed hunks unstaged",
    "  --json                  print one JSON document; stages only with --yes",
    "  --no-color              turn off color",
    "  --help                  print this message",
    "  --version               print the version",
  ].join("\n");
}

export function parseCliArgs(argv: readonly string[]): CliOptions {
  const { values, positionals } = runParseArgs(argv);
  const help = values.help ?? false;
  const version = values.version ?? false;
  const common = {
    dryRun: values["dry-run"] ?? false,
    yes: values.yes ?? false,
    json: values.json ?? false,
    threshold: parseThreshold(values.threshold),
    color: !(values["no-color"] ?? false),
    help,
    version,
  };

  if (help || version) {
    return { intent: "", ...common };
  }

  const exclude = values.exclude;
  return {
    intent: parseIntent(positionals),
    ...(exclude === undefined ? {} : { exclude: parseExclude(exclude) }),
    ...common,
  };
}

function runParseArgs(argv: readonly string[]) {
  try {
    return parseArgs({ ...PARSE_CONFIG, args: [...argv] });
  } catch (error) {
    throw new UsageError(error instanceof Error ? error.message : String(error), { cause: error });
  }
}

function parseIntent(positionals: readonly string[]): string {
  const first = positionals[0];
  if (first === undefined) {
    throw new UsageError('missing sentence; git jev-stage "<sentence>"');
  }
  if (positionals.length > 1) {
    throw new UsageError(
      `expected one sentence, got ${positionals.length}; quote the whole sentence`,
    );
  }
  if (first.trim().length === 0) {
    throw new UsageError("the sentence is empty");
  }
  return first;
}

function parseExclude(value: string): string {
  if (value.trim().length === 0) {
    throw new UsageError("--exclude is empty");
  }
  return value;
}

function parseThreshold(value: string | undefined): number {
  if (value === undefined) {
    return DEFAULT_THRESHOLD;
  }
  const threshold = Number(value);
  if (!Number.isFinite(threshold) || threshold <= 0 || threshold > 1) {
    throw new UsageError(`--threshold must be greater than 0 and at most 1, got ${value}`);
  }
  return threshold;
}
