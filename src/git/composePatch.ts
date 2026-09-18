import { UnknownHunkError } from "../errors.js";
import type { DiffFile, Hunk } from "../types.js";

export interface SelectionFileSummary {
  path: string;
  hunks: number;
  added: number;
  removed: number;
}

export interface SelectionSummary {
  files: number;
  hunks: number;
  added: number;
  removed: number;
  perFile: SelectionFileSummary[];
}

export function composePatch(files: readonly DiffFile[], selectedIds: ReadonlySet<string>): Buffer {
  assertKnownIds(files, selectedIds);

  const parts: Buffer[] = [];
  let total = 0;

  for (const file of files) {
    const selected = selectHunks(file, selectedIds);
    if (selected.length === 0) {
      continue;
    }
    parts.push(file.headerBytes);
    total += file.headerBytes.length;
    for (const hunk of selected) {
      parts.push(hunk.bytes);
      total += hunk.bytes.length;
    }
  }

  return Buffer.concat(parts, total);
}

export function summarizeSelection(
  files: readonly DiffFile[],
  selectedIds: ReadonlySet<string>,
): SelectionSummary {
  assertKnownIds(files, selectedIds);

  const perFile: SelectionFileSummary[] = [];
  let hunks = 0;
  let added = 0;
  let removed = 0;

  for (const file of files) {
    const selected = selectHunks(file, selectedIds);
    if (selected.length === 0) {
      continue;
    }
    const fileAdded = total(selected, (hunk) => hunk.added);
    const fileRemoved = total(selected, (hunk) => hunk.removed);
    perFile.push({
      path: file.path,
      hunks: selected.length,
      added: fileAdded,
      removed: fileRemoved,
    });
    hunks += selected.length;
    added += fileAdded;
    removed += fileRemoved;
  }

  return { files: perFile.length, hunks, added, removed, perFile };
}

function selectHunks(file: DiffFile, selectedIds: ReadonlySet<string>): Hunk[] {
  return file.hunks.filter((hunk) => selectedIds.has(hunk.id));
}

function assertKnownIds(files: readonly DiffFile[], selectedIds: ReadonlySet<string>): void {
  const known = new Set<string>();
  for (const file of files) {
    for (const hunk of file.hunks) {
      known.add(hunk.id);
    }
  }

  const unknown = [...selectedIds].filter((id) => !known.has(id)).sort();
  if (unknown.length > 0) {
    throw new UnknownHunkError(unknown);
  }
}

function total(hunks: readonly Hunk[], pick: (hunk: Hunk) => number): number {
  return hunks.reduce((sum, hunk) => sum + pick(hunk), 0);
}
