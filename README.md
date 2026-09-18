# git-jev-stage

Stage the hunks that match a sentence.

```sh
git jev-stage "only the auth fix and its tests"
```

![demo](docs/demo.gif)

A working tree holds an auth fix, a CSS tweak and a `console.log` left over from debugging. One sentence stages the fix and its test; the rest stays unstaged.

```
$ git jev-stage "only the auth fix and its tests"
M src/auth/login.ts
  + 5072ba1e @@ -1,12 +1,13 @@  include 1.00  exclude 0.00  mixed 0.00
  - 404a01a6 @@ -16,9 +17,10 @@ export async function refresh(req, res) {  include 0.02  exclude 0.96  mixed 0.02
M src/styles/app.css
  - 045da610 @@ -1,2 +1,2 @@  include 0.00  exclude 1.00  mixed 0.00
M test/auth.test.ts
  + 1ff4dc6f @@ -1,5 +1,9 @@  include 0.97  exclude 0.00  mixed 0.03
will stage: 2 hunks, 2 files (+6 -1)
stage 2 hunks in 2 files? [y/N] y
staged 2 hunks in 2 files
$ git status --short
MM src/auth/login.ts
 M src/styles/app.css
M  test/auth.test.ts
```

Then `git commit`, and `git jev-stage "the css change"` for the next one.

## Install

```sh
npm install -g git-jev-stage
export TYPESAFE_API_KEY=...   # early-access key from typesafe.ai
```

Git 2.30 or newer, Node 22 or newer. The key is also read from the nearest `.env` file between the current directory and the repository root.

## How it works

1. **Snapshot.** `git diff` from the index to the working tree, with fixed flags (`--binary --full-index --no-renames --unified=6`), parsed byte for byte into hunks. Each hunk gets an id from its path and bytes. HEAD, the index bytes and the diff are hashed.
2. **One question per hunk.** Every hunk goes to [Jev](https://typesafe.ai) as a `choice` question with three options: `include` (every changed line belongs to the sentence), `exclude` (none does), `mixed` (some do). The sentence and the neighboring hunks of the same file travel along as context. Large diffs are split into windows under a token budget and sent concurrently.
3. **Policy.** `include` or `exclude` with confidence at or above `--threshold` (default 0.6) is taken as is. Anything else, including a missing or malformed answer, is `mixed`.
4. **Plan, then confirm.** The plan prints before anything changes. Each `mixed` hunk is shown and asked about: the whole hunk goes in or stays out. Lines are never split.
5. **Atomic staging.** The selected hunks become one patch. It is applied to a private copy of the index with `git apply --cached --check` and then `git apply --cached`, the copy is verified, `index.lock` is taken, HEAD, the index bytes and the full diff are checked against the snapshot, and the copy is renamed into place. If anything moved in between, nothing is staged and the command exits 3.

The working tree is never written. No commit is made, no message is generated.

## Flags

| Flag | Effect |
|---|---|
| `--exclude "<sentence>"` | Lines matching this sentence never belong. |
| `--dry-run` | Print the plan and the patch that would be staged. No prompts, no changes. |
| `--yes` | Skip the confirmation. `mixed` hunks stay unstaged and are listed. |
| `--json` | One JSON document on stdout, plan on stderr. Stages only with `--yes`. |
| `--threshold 0.6` | Confidence needed to take `include` or `exclude` as given. |
| `--no-color` | Plain output. `NO_COLOR` works too. |

Exit codes: 0 done or nothing to stage, 1 error, 2 usage, 3 the snapshot went stale or the index is locked. Git routes `git jev-stage --help` to a man page; use `git-jev-stage --help`.

## For coding agents

```sh
git jev-stage "the auth fix" --json --yes
```

The document lists every hunk with its `id`, `header`, `text`, `decision`, `source`, `confidence` and `probabilities`, plus `applied`, `stagedHunkIds` and `mixedHunkIds`. An agent stages the mixed ones itself or leaves them.

Claude Code plugin:

```sh
claude plugin marketplace add ibrahemid/git-jev-stage
claude plugin install git-jev-stage@git-jev-stage
```

Other agents: `npx skills add ibrahemid/git-jev-stage`. The skill is `skills/git-jev-stage/SKILL.md`.

## Library

```ts
import { planSelection, applySelection } from "git-jev-stage";

const plan = await planSelection({ cwd, intent: "the auth fix" });
const includeIds = [...plan.decisions.values()]
  .filter((decision) => decision.decision === "include")
  .map((decision) => decision.hunkId);
await applySelection(plan, { includeIds });
```

`planSelection` never mutates. `applySelection` stages exactly the ids it is given. Pass `provider: new FakeProvider(script)` in tests; the same validator runs on scripted and real answers.

## Limits

- Hunks are git's, cut with 6 lines of context. A hunk with wanted and unwanted lines is `mixed`, and is staged whole or not at all.
- Binary, symlink and submodule changes stop the run with an error naming the paths. Stage or stash those first. A submodule that is only dirty is ignored.
- Empty new files and mode-only changes are listed as skipped; stage them with `git add`. Staging any hunk of a file also stages that file's mode change.
- Hunks in different windows of a large diff do not see each other.
- If HEAD, the index or the working tree changes between the plan and your answer, nothing is staged and the command exits 3. Run it again.
- The sentence and the hunk text are sent to api.typesafe.ai. Nothing is written to disk except the index.
- Without a key the command asks about every hunk by hand, like `git add -p` with the sentence on screen.

## Neighbors

- `git add -p`: same granularity, one hunk at a time, no sentence.
- [git-surgeon](https://github.com/raine/git-surgeon): stages explicit hunk ids and line ranges. Built for agents that already know which lines they want.
- [VibeGit](https://github.com/kklemon/vibegit): groups a whole working tree into commits with an LLM. git-jev-stage answers one narrower question and never commits.

## License

MIT
