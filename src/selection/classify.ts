import {
  buildWindows,
  type ChoiceSpec,
  type ClassifyRequest,
  DEFAULT_TOKEN_CEILING,
  estimateJsonTokens,
  type JevProvider,
  type JsonValue,
  runWindows,
  type Window,
  type WindowItem,
} from "../core/index.js";
import type { Decision, HunkDecision, Snapshot } from "../types.js";
import { decide } from "./policy.js";

export const CLASSIFY_CONCURRENCY = 4;

export const BASE_INSTRUCTIONS =
  "Decide, for each hunk marked role=ask, whether its changed lines belong to the change described by intent. Context hunks are for reference only.";

export const EXCLUDE_INSTRUCTIONS = " Lines that match exclude never belong.";

export const HUNK_OPTIONS: Readonly<Record<Decision, string>> = Object.freeze({
  include: "every changed line in this hunk belongs to the described change",
  exclude: "no changed line in this hunk belongs to the described change",
  mixed: "some changed lines belong and some do not",
});

type StateRole = "ask" | "context";
type StateHunk = { id: string; header: string; patch: string; role: StateRole };
type StateFile = { path: string; hunks: StateHunk[] };

export interface ClassifyUsage {
  requests: number;
  inputTokens: number;
  outputTokens: number;
}

export interface ClassifyHunksOptions {
  snapshot: Snapshot;
  intent: string;
  exclude?: string | undefined;
  threshold: number;
  provider: JevProvider;
  tokenCeiling?: number | undefined;
  signal?: AbortSignal | undefined;
}

export interface ClassifyHunksResult {
  decisions: Map<string, HunkDecision>;
  usage: ClassifyUsage;
}

export async function classifyHunks(options: ClassifyHunksOptions): Promise<ClassifyHunksResult> {
  const { snapshot, intent, exclude, threshold, provider, tokenCeiling } = options;
  const instructions = buildInstructions(exclude);
  const ceiling = tokenCeiling ?? DEFAULT_TOKEN_CEILING;
  const sharedTokens = envelopeTokens(intent, exclude);

  const windows = buildWindows(buildItems(snapshot), {
    sharedTokens,
    ...(tokenCeiling === undefined ? {} : { tokenCeiling }),
  });

  const decisions = new Map<string, HunkDecision>();
  const sendable: Window[] = [];
  for (const window of windows) {
    if (window.estimatedTokens > ceiling) {
      for (const hunkId of window.askIds) {
        decisions.set(hunkId, { hunkId, decision: "mixed", source: "too-large" });
      }
      continue;
    }
    sendable.push(window);
  }

  const results = await runWindows(
    sendable,
    (window, _index, signal) =>
      provider.classify(buildRequest(snapshot, intent, exclude, instructions, window), { signal }),
    {
      concurrency: CLASSIFY_CONCURRENCY,
      ...(options.signal === undefined ? {} : { signal: options.signal }),
    },
  );

  const usage: ClassifyUsage = { requests: sendable.length, inputTokens: 0, outputTokens: 0 };
  results.forEach((result, index) => {
    usage.inputTokens += result.usage.inputTokens;
    usage.outputTokens += result.usage.outputTokens;
    const window = sendable[index];
    if (window === undefined) {
      return;
    }
    for (const hunkId of window.askIds) {
      const outcome = result.outcomes[hunkId] ?? { kind: "missing" as const };
      decisions.set(hunkId, { hunkId, ...decide(outcome, threshold) });
    }
  });

  return { decisions, usage };
}

export function envelopeTokens(intent: string, exclude?: string | undefined): number {
  return estimateJsonTokens(buildState(intent, exclude, buildInstructions(exclude), []));
}

export function buildInstructions(exclude: string | undefined): string {
  return exclude === undefined ? BASE_INSTRUCTIONS : `${BASE_INSTRUCTIONS}${EXCLUDE_INSTRUCTIONS}`;
}

function buildItems(snapshot: Snapshot): WindowItem[] {
  const items: WindowItem[] = [];
  for (const file of snapshot.files) {
    for (const hunk of file.hunks) {
      items.push({ id: hunk.id, text: hunk.text, group: file.path, ordinal: hunk.ordinal });
    }
  }
  return items;
}

function buildRequest(
  snapshot: Snapshot,
  intent: string,
  exclude: string | undefined,
  instructions: string,
  window: Window,
): ClassifyRequest<Decision> {
  const roles = new Map<string, StateRole>();
  for (const hunkId of window.contextIds) {
    roles.set(hunkId, "context");
  }
  for (const hunkId of window.askIds) {
    roles.set(hunkId, "ask");
  }

  const files: StateFile[] = [];
  for (const file of snapshot.files) {
    const hunks: StateHunk[] = [];
    for (const hunk of file.hunks) {
      const role = roles.get(hunk.id);
      if (role === undefined) {
        continue;
      }
      hunks.push({ id: hunk.id, header: hunk.header, patch: hunk.text, role });
    }
    if (hunks.length > 0) {
      files.push({ path: file.path, hunks });
    }
  }

  const questions: Record<string, ChoiceSpec<Decision>> = {};
  for (const hunkId of window.askIds) {
    questions[hunkId] = {
      instructions: `Does hunk ${hunkId} belong to the described change?`,
      options: { ...HUNK_OPTIONS },
    };
  }

  return { state: buildState(intent, exclude, instructions, files), questions };
}

function buildState(
  intent: string,
  exclude: string | undefined,
  instructions: string,
  files: StateFile[],
): JsonValue {
  return {
    intent,
    ...(exclude === undefined ? {} : { exclude }),
    instructions,
    files,
  };
}
