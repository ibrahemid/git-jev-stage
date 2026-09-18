import { realpathSync } from "node:fs";
import { createInterface, type Interface } from "node:readline";
import { pathToFileURL } from "node:url";
import {
  createProviderFromEnv,
  FakeProvider,
  type JevProvider,
  ProviderConfigError,
  ProviderError,
} from "../core/index.js";
import { JevStageError, MissingApiKeyError, UsageError } from "../errors.js";
import { cleanupOwnedPaths } from "../git/applySelection.js";
import { composePatch, summarizeSelection } from "../git/composePatch.js";
import { applySelection, planSelection } from "../library.js";
import type { Decision, Hunk, HunkDecision, Plan } from "../types.js";
import { VERSION } from "../version.js";
import { type CliOptions, parseCliArgs, usageText } from "./args.js";
import { type JsonDocumentOptions, renderJsonDocument } from "./json.js";
import { loadDotEnvFromTree } from "./loadEnv.js";
import { askHunk, confirm, NO_TTY_MESSAGE } from "./prompt.js";
import { count, renderPatch, renderPlan, renderSkipped, shouldColor } from "./render.js";

const SIGINT_EXIT_CODE = 130;
const SIGTERM_EXIT_CODE = 143;

// Test-only hook: a JSON FakeProvider script replaces the network provider.
const FAKE_PROVIDER_ENV = "GIT_JEV_STAGE_FAKE_PROVIDER";

export interface CliIo {
  stdout: (text: string) => void;
  stderr: (text: string) => void;
  stdoutBytes: (bytes: Buffer) => void;
  isStdoutTty: boolean;
  isStdinTty: boolean;
  readLine: () => Promise<string | undefined>;
  cwd: string;
  env: Record<string, string | undefined>;
}

export async function run(argv: readonly string[], io: CliIo): Promise<number> {
  try {
    loadDotEnvFromTree(io.cwd, io.env);
    const options = parseCliArgs(argv);

    if (options.help) {
      io.stdout(`${usageText()}\n`);
      return 0;
    }
    if (options.version) {
      io.stdout(`${VERSION}\n`);
      return 0;
    }

    await stage(options, io);
    return 0;
  } catch (error) {
    const { message, exitCode } = toExit(error);
    io.stderr(`${message}\n`);
    return exitCode;
  }
}

export async function main(argv: readonly string[]): Promise<number> {
  const reader = createLineReader();
  const io: CliIo = {
    stdout: (text) => {
      process.stdout.write(text);
    },
    stderr: (text) => {
      process.stderr.write(text);
    },
    stdoutBytes: (bytes) => {
      process.stdout.write(bytes);
    },
    isStdoutTty: process.stdout.isTTY === true,
    isStdinTty: process.stdin.isTTY === true,
    readLine: () => reader.readLine(),
    cwd: process.cwd(),
    env: process.env,
  };

  const onInterrupt = createSignalHandler(SIGINT_EXIT_CODE);
  const onTerminate = createSignalHandler(SIGTERM_EXIT_CODE);
  process.on("SIGINT", onInterrupt);
  process.on("SIGTERM", onTerminate);

  try {
    return await run(argv, io);
  } finally {
    process.off("SIGINT", onInterrupt);
    process.off("SIGTERM", onTerminate);
    reader.close();
  }
}

async function stage(options: CliOptions, io: CliIo): Promise<void> {
  const interactive = !options.json && !options.yes && !options.dryRun;
  if (interactive && !io.isStdinTty) {
    throw new UsageError(NO_TTY_MESSAGE);
  }

  const provider = resolveProvider(io.env);
  if (provider === undefined && (options.yes || options.json)) {
    throw new MissingApiKeyError();
  }

  const report = options.json ? io.stderr : io.stdout;
  const plan = await planSelection({
    cwd: io.cwd,
    intent: options.intent,
    ...(options.exclude === undefined ? {} : { exclude: options.exclude }),
    threshold: options.threshold,
    ...(provider === undefined ? {} : { provider }),
  });

  if (plan.snapshot.files.length === 0) {
    report(renderSkipped(plan.snapshot.skipped));
    if (options.json) {
      io.stdout(renderJsonDocument({ plan, applied: false, stagedHunkIds: [], mixedHunkIds: [] }));
      return;
    }
    report("nothing to stage\n");
    return;
  }

  const decided = provider === undefined && interactive ? await decideByHand(plan, io) : plan;
  const includeIds = new Set(idsWithDecision(decided, "include"));
  report(
    renderPlan({
      plan: decided,
      includeIds,
      color: shouldColor({
        requested: options.color,
        isTty: io.isStdoutTty,
        noColor: io.env.NO_COLOR,
      }),
    }),
  );

  if (options.dryRun) {
    if (options.json) {
      io.stdout(renderJsonDocument(plannedDocument(decided, includeIds)));
      return;
    }
    renderPatch(composePatch(decided.snapshot.files, includeIds), io.stdoutBytes);
    return;
  }

  if (interactive) {
    for (const hunk of hunksWithDecision(decided, "mixed")) {
      if (await askHunk(hunk, io)) {
        includeIds.add(hunk.id);
      }
    }
    const pending = summarizeSelection(decided.snapshot.files, includeIds);
    const confirmed = await confirm(
      `stage ${count(pending.hunks, "hunk")} in ${count(pending.files, "file")}?`,
      io,
    );
    if (!confirmed) {
      report("nothing staged\n");
      return;
    }
  }

  if (options.json && !options.yes) {
    io.stdout(renderJsonDocument(plannedDocument(decided, includeIds)));
    return;
  }

  const result = await applySelection(decided, { includeIds: [...includeIds] });
  if (options.json) {
    io.stdout(
      renderJsonDocument({
        plan: decided,
        applied: true,
        stagedHunkIds: result.stagedHunkIds,
        mixedHunkIds: result.skippedMixedIds,
      }),
    );
  }

  const staged = summarizeSelection(decided.snapshot.files, new Set(result.stagedHunkIds));
  report(`staged ${count(staged.hunks, "hunk")} in ${count(staged.files, "file")}\n`);
  if (result.skippedMixedIds.length > 0) {
    report(`left unstaged: ${count(result.skippedMixedIds.length, "mixed hunk")}\n`);
  }
}

function plannedDocument(plan: Plan, includeIds: ReadonlySet<string>): JsonDocumentOptions {
  return {
    plan,
    applied: false,
    stagedHunkIds: [],
    mixedHunkIds: idsWithDecision(plan, "mixed").filter((id) => !includeIds.has(id)),
  };
}

async function decideByHand(plan: Plan, io: CliIo): Promise<Plan> {
  io.stdout("no TYPESAFE_API_KEY, deciding by hand\n");
  const decisions = new Map<string, HunkDecision>();
  for (const file of plan.snapshot.files) {
    for (const hunk of file.hunks) {
      const wanted = await askHunk(hunk, io);
      decisions.set(hunk.id, {
        hunkId: hunk.id,
        decision: wanted ? "include" : "exclude",
        source: "manual",
      });
    }
  }
  return { ...plan, decisions };
}

function resolveProvider(env: Record<string, string | undefined>): JevProvider | undefined {
  const scriptPath = env[FAKE_PROVIDER_ENV];
  if (scriptPath !== undefined && scriptPath.length > 0) {
    return FakeProvider.fromJsonFile(scriptPath);
  }
  return createProviderFromEnv(env);
}

function idsWithDecision(plan: Plan, decision: Decision): string[] {
  return hunksWithDecision(plan, decision).map((hunk) => hunk.id);
}

function hunksWithDecision(plan: Plan, decision: Decision): Hunk[] {
  const hunks: Hunk[] = [];
  for (const file of plan.snapshot.files) {
    for (const hunk of file.hunks) {
      if (plan.decisions.get(hunk.id)?.decision === decision) {
        hunks.push(hunk);
      }
    }
  }
  return hunks;
}

function toExit(error: unknown): { message: string; exitCode: number } {
  if (error instanceof JevStageError) {
    return { message: `git-jev-stage: ${error.code}: ${error.message}`, exitCode: error.exitCode };
  }
  if (error instanceof ProviderError || error instanceof ProviderConfigError) {
    return { message: `git-jev-stage: provider: ${error.message}`, exitCode: 1 };
  }
  const detail = error instanceof Error ? error.message : String(error);
  return { message: `git-jev-stage: internal: ${detail}`, exitCode: 1 };
}

interface LineReader {
  readLine: () => Promise<string | undefined>;
  close: () => void;
}

function createLineReader(): LineReader {
  let readerInterface: Interface | undefined;
  let lines: AsyncIterator<string> | undefined;

  return {
    async readLine(): Promise<string | undefined> {
      if (lines === undefined) {
        readerInterface = createInterface({
          input: process.stdin,
          crlfDelay: Number.POSITIVE_INFINITY,
        });
        lines = readerInterface[Symbol.asyncIterator]();
      }
      const next = await lines.next();
      return next.done === true ? undefined : next.value;
    },
    close(): void {
      readerInterface?.close();
      readerInterface = undefined;
      lines = undefined;
    },
  };
}

function createSignalHandler(exitCode: number): () => void {
  return () => {
    cleanupOwnedPaths();
    process.exit(exitCode);
  };
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
