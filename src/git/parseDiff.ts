import { DiffParseError, UnsupportedEntryError, type UnsupportedEntryKind } from "../errors.js";
import type { DiffFile, FileKind, Hunk } from "../types.js";
import { hashHunkId } from "./hash.js";

export interface UnsupportedEntry {
  path: string;
  kind: UnsupportedEntryKind;
}

export interface ParsedDiff {
  files: DiffFile[];
  unsupported: UnsupportedEntry[];
}

const LF = 0x0a;
const CR = 0x0d;
const SPACE = 0x20;
const QUOTE = 0x22;
const PLUS = 0x2b;
const MINUS = 0x2d;
const BACKSLASH = 0x5c;

const FILE_HEADER = "diff --git ";
const HUNK_HEADER = "@@ ";
const OLD_FILE = "--- ";
const NEW_FILE = "+++ ";
const NEW_FILE_MODE = "new file mode ";
const DELETED_FILE_MODE = "deleted file mode ";
const OLD_MODE = "old mode ";
const NEW_MODE = "new mode ";
const INDEX_LINE = "index ";
const BINARY_PATCH = "GIT binary patch";
const BINARY_FILES = "Binary files ";
const BINARY_FILES_SUFFIX = " differ";
const DEV_NULL = "/dev/null";
const SYMLINK_MODE = "120000";
const SUBMODULE_MODE = "160000";
const SUBPROJECT_MARKERS = [" Subproject commit ", "+Subproject commit ", "-Subproject commit "];
const SIDE_PREFIXES = ["a/", "b/"];
const DIFF_GIT_PATHS_OVERHEAD = "a/ b/".length;
const UNSUPPORTED_KIND_ORDER: UnsupportedEntryKind[] = ["binary", "symlink", "submodule"];

const SIMPLE_ESCAPES = new Map<number, number>([
  [0x22, 0x22],
  [0x5c, 0x5c],
  [0x61, 0x07],
  [0x62, 0x08],
  [0x66, 0x0c],
  [0x6e, 0x0a],
  [0x72, 0x0d],
  [0x74, 0x09],
  [0x76, 0x0b],
]);

interface Line {
  start: number;
  end: number;
}

interface FileMeta {
  newPath: string | undefined;
  oldPath: string | undefined;
  isNewFile: boolean;
  isDeletedFile: boolean;
  hasOldMode: boolean;
  hasNewMode: boolean;
  binary: boolean;
  symlink: boolean;
  submodule: boolean;
}

export function parseUnifiedDiff(diff: Buffer): DiffFile[] {
  const parsed = parseUnifiedDiffDetailed(diff);
  const error = buildUnsupportedEntryError(parsed.unsupported);
  if (error !== undefined) {
    throw error;
  }
  return parsed.files;
}

export function parseUnifiedDiffDetailed(diff: Buffer): ParsedDiff {
  if (diff.length === 0) {
    return { files: [], unsupported: [] };
  }

  const lines = splitLines(diff);
  const sectionStarts = findSectionStarts(diff, lines);
  if (sectionStarts[0] !== 0) {
    throw new DiffParseError("the diff does not start with a 'diff --git' header");
  }

  const files: DiffFile[] = [];
  const unsupported: UnsupportedEntry[] = [];

  for (let index = 0; index < sectionStarts.length; index += 1) {
    const startLine = sectionStarts[index];
    if (startLine === undefined) {
      continue;
    }
    const endLine = sectionStarts[index + 1] ?? lines.length;
    const file = parseSection(diff, lines, startLine, endLine);
    files.push(file.file);
    if (file.unsupported !== undefined) {
      unsupported.push({ path: file.file.path, kind: file.unsupported });
    }
  }

  assertByteExact(diff, files);
  return { files, unsupported };
}

export function buildUnsupportedEntryError(
  entries: readonly UnsupportedEntry[],
): UnsupportedEntryError | undefined {
  for (const kind of UNSUPPORTED_KIND_ORDER) {
    const paths = entries.filter((entry) => entry.kind === kind).map((entry) => entry.path);
    if (paths.length > 0) {
      return new UnsupportedEntryError(kind, paths);
    }
  }
  return undefined;
}

function parseSection(
  diff: Buffer,
  lines: Line[],
  startLine: number,
  endLine: number,
): { file: DiffFile; unsupported: UnsupportedEntryKind | undefined } {
  const headerLine = lines[startLine];
  const lastLine = lines[endLine - 1];
  if (headerLine === undefined || lastLine === undefined) {
    throw new DiffParseError("the diff ends inside a file section");
  }

  let firstHunkLine = endLine;
  for (let index = startLine + 1; index < endLine; index += 1) {
    const line = lines[index];
    if (line !== undefined && lineStartsWith(diff, line, HUNK_HEADER)) {
      firstHunkLine = index;
      break;
    }
  }

  const meta = readFileMeta(diff, lines, startLine, firstHunkLine);
  const path = resolvePath(diff, headerLine, meta);
  const hunkStarts = findHunkStarts(diff, lines, firstHunkLine, endLine);
  const hunks = buildHunks(diff, lines, hunkStarts, endLine, path);

  if (hasSubprojectLines(diff, lines, firstHunkLine, endLine)) {
    meta.submodule = true;
  }

  const headerEnd =
    firstHunkLine < endLine ? (lines[firstHunkLine]?.start ?? lastLine.end) : lastLine.end;

  return {
    file: {
      path,
      kind: resolveKind(meta, hunks.length),
      headerBytes: diff.subarray(headerLine.start, headerEnd),
      hunks,
    },
    unsupported: resolveUnsupportedKind(meta),
  };
}

function readFileMeta(
  diff: Buffer,
  lines: Line[],
  startLine: number,
  headerEndLine: number,
): FileMeta {
  const meta: FileMeta = {
    newPath: undefined,
    oldPath: undefined,
    isNewFile: false,
    isDeletedFile: false,
    hasOldMode: false,
    hasNewMode: false,
    binary: false,
    symlink: false,
    submodule: false,
  };

  for (let index = startLine + 1; index < headerEndLine; index += 1) {
    const line = lines[index];
    if (line === undefined) {
      continue;
    }
    if (lineStartsWith(diff, line, NEW_FILE)) {
      meta.newPath = pathFromSideLine(diff, line);
      continue;
    }
    if (lineStartsWith(diff, line, OLD_FILE)) {
      meta.oldPath = pathFromSideLine(diff, line);
      continue;
    }

    const text = decodeLine(diff, line);
    if (text === BINARY_PATCH) {
      meta.binary = true;
    } else if (text.startsWith(BINARY_FILES) && text.endsWith(BINARY_FILES_SUFFIX)) {
      meta.binary = true;
    } else if (text.startsWith(NEW_FILE_MODE)) {
      meta.isNewFile = true;
      applyMode(meta, text.slice(NEW_FILE_MODE.length));
    } else if (text.startsWith(DELETED_FILE_MODE)) {
      meta.isDeletedFile = true;
      applyMode(meta, text.slice(DELETED_FILE_MODE.length));
    } else if (text.startsWith(OLD_MODE)) {
      meta.hasOldMode = true;
      applyMode(meta, text.slice(OLD_MODE.length));
    } else if (text.startsWith(NEW_MODE)) {
      meta.hasNewMode = true;
      applyMode(meta, text.slice(NEW_MODE.length));
    } else if (text.startsWith(INDEX_LINE)) {
      applyMode(meta, text.split(" ")[2] ?? "");
    }
  }

  return meta;
}

function applyMode(meta: FileMeta, mode: string): void {
  const value = mode.trim();
  if (value === SYMLINK_MODE) {
    meta.symlink = true;
  } else if (value === SUBMODULE_MODE) {
    meta.submodule = true;
  }
}

function resolveKind(meta: FileMeta, hunkCount: number): FileKind {
  if (meta.isNewFile) {
    return "added";
  }
  if (meta.isDeletedFile) {
    return "deleted";
  }
  if (hunkCount === 0 && meta.hasOldMode && meta.hasNewMode && !meta.binary) {
    return "mode-only";
  }
  return "modified";
}

function resolveUnsupportedKind(meta: FileMeta): UnsupportedEntryKind | undefined {
  if (meta.submodule) {
    return "submodule";
  }
  if (meta.symlink) {
    return "symlink";
  }
  if (meta.binary) {
    return "binary";
  }
  return undefined;
}

function resolvePath(diff: Buffer, headerLine: Line, meta: FileMeta): string {
  if (meta.newPath !== undefined && meta.newPath !== DEV_NULL) {
    return meta.newPath;
  }
  if (meta.oldPath !== undefined && meta.oldPath !== DEV_NULL) {
    return meta.oldPath;
  }
  return pathFromFileHeaderLine(diff, headerLine);
}

function findSectionStarts(diff: Buffer, lines: Line[]): number[] {
  const starts: number[] = [];
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    if (line !== undefined && lineStartsWith(diff, line, FILE_HEADER)) {
      starts.push(index);
    }
  }
  return starts;
}

function findHunkStarts(diff: Buffer, lines: Line[], from: number, to: number): number[] {
  const starts: number[] = [];
  for (let index = from; index < to; index += 1) {
    const line = lines[index];
    if (line !== undefined && lineStartsWith(diff, line, HUNK_HEADER)) {
      starts.push(index);
    }
  }
  return starts;
}

function buildHunks(
  diff: Buffer,
  lines: Line[],
  hunkStarts: number[],
  sectionEndLine: number,
  path: string,
): Hunk[] {
  const hunks: Hunk[] = [];

  for (let ordinal = 0; ordinal < hunkStarts.length; ordinal += 1) {
    const startLine = hunkStarts[ordinal];
    if (startLine === undefined) {
      continue;
    }
    const endLine = hunkStarts[ordinal + 1] ?? sectionEndLine;
    const first = lines[startLine];
    const last = lines[endLine - 1];
    if (first === undefined || last === undefined) {
      throw new DiffParseError("the diff ends inside a hunk");
    }

    const bytes = diff.subarray(first.start, last.end);
    let added = 0;
    let removed = 0;
    for (let index = startLine + 1; index < endLine; index += 1) {
      const line = lines[index];
      if (line === undefined) {
        continue;
      }
      const marker = diff[line.start];
      if (marker === PLUS) {
        added += 1;
      } else if (marker === MINUS) {
        removed += 1;
      }
    }

    hunks.push({
      id: hashHunkId(path, bytes),
      path,
      ordinal,
      header: decodeLine(diff, first),
      bytes,
      text: bytes.toString("utf8"),
      added,
      removed,
    });
  }

  return hunks;
}

function hasSubprojectLines(diff: Buffer, lines: Line[], from: number, to: number): boolean {
  for (let index = from; index < to; index += 1) {
    const line = lines[index];
    if (line === undefined) {
      continue;
    }
    if (SUBPROJECT_MARKERS.some((marker) => lineStartsWith(diff, line, marker))) {
      return true;
    }
  }
  return false;
}

function assertByteExact(diff: Buffer, files: DiffFile[]): void {
  const parts: Buffer[] = [];
  let total = 0;
  for (const file of files) {
    parts.push(file.headerBytes);
    total += file.headerBytes.length;
    for (const hunk of file.hunks) {
      parts.push(hunk.bytes);
      total += hunk.bytes.length;
    }
  }
  if (total !== diff.length) {
    throw new DiffParseError(`the parsed diff covers ${total} of ${diff.length} bytes`);
  }
  if (!Buffer.concat(parts, total).equals(diff)) {
    throw new DiffParseError("the parsed diff does not reassemble to the input bytes");
  }
}

function splitLines(diff: Buffer): Line[] {
  const lines: Line[] = [];
  let start = 0;
  while (start < diff.length) {
    const newline = diff.indexOf(LF, start);
    if (newline === -1) {
      lines.push({ start, end: diff.length });
      break;
    }
    lines.push({ start, end: newline + 1 });
    start = newline + 1;
  }
  return lines;
}

function lineStartsWith(diff: Buffer, line: Line, prefix: string): boolean {
  if (line.end - line.start < prefix.length) {
    return false;
  }
  return diff.toString("latin1", line.start, line.start + prefix.length) === prefix;
}

function contentEnd(diff: Buffer, line: Line): number {
  let end = line.end;
  if (end > line.start && diff[end - 1] === LF) {
    end -= 1;
  }
  if (end > line.start && diff[end - 1] === CR) {
    end -= 1;
  }
  return end;
}

function decodeLine(diff: Buffer, line: Line): string {
  return diff.toString("utf8", line.start, contentEnd(diff, line));
}

function pathFromSideLine(diff: Buffer, line: Line): string {
  const raw = diff.subarray(line.start + OLD_FILE.length, contentEnd(diff, line));
  if (raw[0] === QUOTE) {
    return stripSidePrefix(unquoteCStyle(raw));
  }
  let value = raw.toString("utf8");
  if (value.includes(" ") && value.endsWith("\t")) {
    value = value.slice(0, -1);
  }
  return stripSidePrefix(value);
}

function pathFromFileHeaderLine(diff: Buffer, line: Line): string {
  const raw = diff.subarray(line.start + FILE_HEADER.length, contentEnd(diff, line));
  if (raw[0] === QUOTE) {
    const secondStart = quotedTokenEnd(raw, 0) + 1;
    if (raw[secondStart - 1] !== SPACE || raw[secondStart] !== QUOTE) {
      throw new DiffParseError("malformed 'diff --git' header");
    }
    return stripSidePrefix(unquoteCStyle(raw.subarray(secondStart)));
  }

  const remaining = raw.length - DIFF_GIT_PATHS_OVERHEAD;
  if (remaining <= 0 || remaining % 2 !== 0) {
    throw new DiffParseError("malformed 'diff --git' header");
  }
  return raw.subarray(raw.length - remaining / 2).toString("utf8");
}

function stripSidePrefix(value: string): string {
  if (value === DEV_NULL) {
    return DEV_NULL;
  }
  for (const prefix of SIDE_PREFIXES) {
    if (value.startsWith(prefix)) {
      return value.slice(prefix.length);
    }
  }
  return value;
}

function quotedTokenEnd(raw: Buffer, start: number): number {
  let index = start + 1;
  while (index < raw.length) {
    const byte = raw[index];
    if (byte === BACKSLASH) {
      index += 2;
      continue;
    }
    if (byte === QUOTE) {
      return index + 1;
    }
    index += 1;
  }
  throw new DiffParseError("unterminated quoted path in the diff header");
}

function unquoteCStyle(raw: Buffer): string {
  const out: number[] = [];
  let index = 1;
  let closed = false;

  while (index < raw.length) {
    const byte = raw[index];
    if (byte === undefined) {
      break;
    }
    if (byte === QUOTE) {
      closed = true;
      break;
    }
    if (byte !== BACKSLASH) {
      out.push(byte);
      index += 1;
      continue;
    }

    const escaped = raw[index + 1];
    if (escaped === undefined) {
      throw new DiffParseError("truncated escape in a quoted diff path");
    }
    if (escaped >= 0x30 && escaped <= 0x37) {
      let value = 0;
      let digits = 0;
      while (digits < 3) {
        const digit = raw[index + 1 + digits];
        if (digit === undefined || digit < 0x30 || digit > 0x37) {
          break;
        }
        value = value * 8 + (digit - 0x30);
        digits += 1;
      }
      if (value > 0xff) {
        throw new DiffParseError("octal escape out of range in a quoted diff path");
      }
      out.push(value);
      index += 1 + digits;
      continue;
    }

    const mapped = SIMPLE_ESCAPES.get(escaped);
    if (mapped === undefined) {
      throw new DiffParseError("unknown escape in a quoted diff path");
    }
    out.push(mapped);
    index += 2;
  }

  if (!closed) {
    throw new DiffParseError("unterminated quoted path in the diff header");
  }
  return Buffer.from(out).toString("utf8");
}
