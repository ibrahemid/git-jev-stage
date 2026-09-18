---
name: git-jev-stage
description: Stage only the diff hunks that match a sentence, with git jev-stage. Use when asked to commit or stage part of the working tree ("commit just the auth fix", "stage only the tests", "leave the debug logging out").
allowed-tools: Bash(git jev-stage *) Bash(git status *) Bash(git diff *) Bash(git commit *) Bash(git add *)
---

`git jev-stage "<sentence>"` classifies every unstaged hunk against the sentence and stages the ones that belong. It never commits, never edits files, and never stages a hunk it is unsure about.

## Steps

1. Run the plan in machine mode:

   ```
   git jev-stage "<what to stage>" --json --yes
   ```

   Add `--exclude "<what to leave out>"` when the request names something to keep out.

2. Read the JSON. `applied: true` means the `include` hunks are now in the index. `mixedHunkIds` lists hunks the tool did not stage because they hold both wanted and unwanted lines, or because it was not confident.

3. If `mixedHunkIds` is non-empty, decide each one yourself: read the hunk under `files[].hunks[]` (its `header` and `text`), then stage the whole hunk with `git add -p` if it belongs, or leave it. Never edit the working tree to split a hunk.

4. Confirm with `git diff --cached --stat`, then commit.

## Failure modes

- Exit 1 with `missing-api-key`: `TYPESAFE_API_KEY` is not set. Fall back to `git add -p`.
- Exit 3 with `stale-snapshot` or `index-locked`: the working tree, index, or HEAD changed while planning, or another git process holds the index. Nothing was staged. Run the command again.
- Exit 1 with `unsupported-entry`: binary, symlink, or submodule changes are present. Stage those by path with `git add` first, or stash them, then rerun.

## Do not

- Do not pass `--yes` without `--json` in an agent session; the interactive prompt cannot be answered.
- Do not describe the whole diff. One sentence naming the change to keep is enough; everything else stays unstaged.
