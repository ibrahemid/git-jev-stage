import { DEFAULT_PER_QUESTION_TOKENS, DEFAULT_TOKEN_CEILING, estimateTokens } from "./tokens.js";
import type { RunWindowsOptions, Window, WindowItem, WindowOptions } from "./types.js";

export const DEFAULT_CONCURRENCY = 4;

interface Entry {
  index: number;
  id: string;
  tokens: number;
}

export function buildWindows(items: readonly WindowItem[], options: WindowOptions): Window[] {
  const ceiling = options.tokenCeiling ?? DEFAULT_TOKEN_CEILING;
  const perQuestionTokens = options.perQuestionTokens ?? DEFAULT_PER_QUESTION_TOKENS;
  const withContext = options.neighborContext ?? true;
  const shared = options.sharedTokens;

  const entries: Entry[] = items.map((item, index) => ({
    index,
    id: item.id,
    tokens: estimateTokens(item.text),
  }));
  const neighbors = buildNeighborIndex(items, entries);

  const packed: Entry[][] = [];
  let current: Entry[] = [];
  let currentCost = shared;

  for (const entry of entries) {
    const askCost = entry.tokens + perQuestionTokens;
    if (shared + askCost > ceiling) {
      if (current.length > 0) {
        packed.push(current);
        current = [];
        currentCost = shared;
      }
      packed.push([entry]);
      continue;
    }
    if (current.length > 0 && currentCost + askCost > ceiling) {
      packed.push(current);
      current = [];
      currentCost = shared;
    }
    current.push(entry);
    currentCost += askCost;
  }
  if (current.length > 0) {
    packed.push(current);
  }

  return packed.map((asks) => {
    const asked = new Set(asks.map((entry) => entry.index));
    const context: Entry[] = [];
    let cost = shared;
    for (const entry of asks) {
      cost += entry.tokens + perQuestionTokens;
    }
    if (withContext) {
      const taken = new Set<number>();
      for (const entry of asks) {
        for (const candidate of neighbors.get(entry.index) ?? []) {
          if (asked.has(candidate.index) || taken.has(candidate.index)) {
            continue;
          }
          if (cost + candidate.tokens > ceiling) {
            continue;
          }
          taken.add(candidate.index);
          context.push(candidate);
          cost += candidate.tokens;
        }
      }
    }
    return {
      askIds: asks.map((entry) => entry.id),
      contextIds: context.map((entry) => entry.id),
      estimatedTokens: cost,
    };
  });
}

export async function runWindows<T>(
  windows: readonly Window[],
  fn: (window: Window, index: number, signal: AbortSignal) => Promise<T>,
  options: RunWindowsOptions = {},
): Promise<T[]> {
  options.signal?.throwIfAborted();
  if (windows.length === 0) {
    return [];
  }

  const concurrency = Math.max(1, Math.trunc(options.concurrency ?? DEFAULT_CONCURRENCY));
  const results = new Array<T>(windows.length);
  const controller = new AbortController();
  const external = options.signal;
  const forwardAbort = (): void => {
    controller.abort(external?.reason);
  };
  external?.addEventListener("abort", forwardAbort, { once: true });

  let cursor = 0;
  let failed = false;
  let failure: unknown;

  const worker = async (): Promise<void> => {
    while (!failed) {
      const index = cursor;
      cursor += 1;
      const window = windows[index];
      if (window === undefined) {
        return;
      }
      try {
        results[index] = await fn(window, index, controller.signal);
      } catch (error) {
        if (!failed) {
          failed = true;
          failure = error;
          controller.abort();
        }
        return;
      }
    }
  };

  try {
    await Promise.all(
      Array.from({ length: Math.min(concurrency, windows.length) }, () => worker()),
    );
  } finally {
    external?.removeEventListener("abort", forwardAbort);
  }

  if (failed) {
    throw failure;
  }
  return results;
}

function buildNeighborIndex(
  items: readonly WindowItem[],
  entries: readonly Entry[],
): Map<number, Entry[]> {
  const groups = new Map<string, Entry[]>();
  items.forEach((item, index) => {
    const entry = entries[index];
    if (entry === undefined) {
      return;
    }
    const bucket = groups.get(item.group);
    if (bucket === undefined) {
      groups.set(item.group, [entry]);
    } else {
      bucket.push(entry);
    }
  });

  const neighbors = new Map<number, Entry[]>();
  for (const bucket of groups.values()) {
    const ordered = [...bucket].sort((left, right) => {
      const leftItem = items[left.index];
      const rightItem = items[right.index];
      if (leftItem === undefined || rightItem === undefined) {
        return left.index - right.index;
      }
      return leftItem.ordinal - rightItem.ordinal || left.index - right.index;
    });
    ordered.forEach((entry, position) => {
      const candidates: Entry[] = [];
      const previous = ordered[position - 1];
      const next = ordered[position + 1];
      if (previous !== undefined) {
        candidates.push(previous);
      }
      if (next !== undefined) {
        candidates.push(next);
      }
      neighbors.set(entry.index, candidates);
    });
  }
  return neighbors;
}
