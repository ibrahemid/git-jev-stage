import process from "node:process";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { loadDotEnv } from "../../src/cli/loadEnv.js";
import type { ChoiceSpec, ClassifyRequest } from "../../src/core/index.js";
import { TypeSafeJevProvider } from "../../src/core/index.js";

type Label = "include" | "exclude" | "mixed";

const REPO_ROOT = fileURLToPath(new URL("../../", import.meta.url));

if (process.env.JEV_LIVE === "1") {
  loadDotEnv(REPO_ROOT);
}

const apiKey = process.env.TYPESAFE_API_KEY ?? "";
const live = process.env.JEV_LIVE === "1" && apiKey.length > 0;

const HUNKS = [
  {
    id: "a1b2c3d4e5f60001",
    path: "src/auth/login.ts",
    header: "@@ -12,6 +12,9 @@ export async function login(",
    patch:
      "@@ -12,6 +12,9 @@ export async function login(\n   const user = await findUser(email);\n+  if (user.lockedUntil > Date.now()) {\n+    throw new AccountLockedError(user.id);\n+  }\n   return issueSession(user);\n",
  },
  {
    id: "a1b2c3d4e5f60002",
    path: "src/styles/theme.css",
    header: "@@ -4,3 +4,7 @@ :root {",
    patch:
      "@@ -4,3 +4,7 @@ :root {\n   --bg: #fff;\n+  --radius: 8px;\n+  --shadow: 0 1px 2px rgba(0,0,0,0.1);\n }\n",
  },
  {
    id: "a1b2c3d4e5f60003",
    path: "src/auth/session.ts",
    header: "@@ -30,4 +30,8 @@ export function issueSession(",
    patch:
      "@@ -30,4 +30,8 @@ export function issueSession(\n   const token = randomToken();\n+  await recordFailedAttempt(user.id);\n   return token;\n }\n",
  },
] as const;

const OPTIONS: Record<Label, string> = {
  include: "every changed line in this hunk belongs to the described change",
  exclude: "no changed line in this hunk belongs to the described change",
  mixed: "some changed lines belong and some do not",
};

function buildRequest(): ClassifyRequest<Label> {
  const questions: Record<string, ChoiceSpec<Label>> = {};
  for (const hunk of HUNKS) {
    questions[hunk.id] = {
      instructions: `Does hunk ${hunk.id} belong to the described change?`,
      options: OPTIONS,
    };
  }
  return {
    state: {
      intent: "lock accounts after repeated failed logins",
      instructions:
        "Decide, for each hunk marked role=ask, whether its changed lines belong to the change described by intent. Context hunks are for reference only.",
      files: HUNKS.map((hunk) => ({
        path: hunk.path,
        hunks: [{ id: hunk.id, header: hunk.header, patch: hunk.patch, role: "ask" }],
      })),
    },
    questions,
  };
}

describe.skipIf(!live)("jev live", () => {
  it("answers every hunk question", async () => {
    const provider = new TypeSafeJevProvider({ apiKey });
    const result = await provider.classify(buildRequest());

    expect(Object.keys(result.outcomes)).toEqual(HUNKS.map((hunk) => hunk.id));
    for (const [id, outcome] of Object.entries(result.outcomes)) {
      expect(outcome.kind, `${id} -> ${JSON.stringify(outcome)}`).toBe("answer");
    }
    expect(result.usage.inputTokens).toBeGreaterThan(0);
    expect(result.model.length).toBeGreaterThan(0);
  }, 60_000);
});
