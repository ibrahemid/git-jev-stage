import { createHash } from "node:crypto";

const HUNK_ID_LENGTH = 16;
const SEPARATOR = Buffer.from([0]);

export function hashBytes(bytes: Buffer): string {
  return createHash("sha256").update(bytes).digest("hex");
}

export function hashHunkId(path: string, bytes: Buffer): string {
  return createHash("sha256")
    .update(Buffer.from(path, "utf8"))
    .update(SEPARATOR)
    .update(bytes)
    .digest("hex")
    .slice(0, HUNK_ID_LENGTH);
}
