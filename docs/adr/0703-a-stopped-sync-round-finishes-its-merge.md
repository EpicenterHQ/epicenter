# 0703. A stopped sync round finishes its merge

- **Status:** Proposed
- **Date:** 2026-11-01
- **Amends:** [ADR-0565](0565-a-refresh-token-keeps-its-grants-scopes-and-only-each-access-token-is-narrowed-to-its-audience.md) at "The CLI and the shell narrow the first path": the shell kills a CLI child's process group after `STOP_GRACE`, 65 seconds, not three, and a stop signal waits for a sync round under way for up to `ROUND_GRACE_MS`, a minute, as well as for a refresh's keychain write for up to `STOP_GRACE_MS`, two seconds.
- **Relates:** [ADR-0700](0700-apps-share-data-through-a-file-contract-recorded-in-git.md) (a sync round fetches, merges, commits, and pushes a folder's repository).

## Context

ADR-0565 has the CLI wait at most two seconds (`STOP_GRACE_MS` in
`packages/cli/src/stop.ts`) for a refresh's keychain write on a stop signal,
and the shell send SIGTERM to a CLI child's process group and SIGKILL three
seconds later (`STOP_GRACE` in `apps/epicenter/src-tauri/src/cli.rs`).

The Epicenter app runs `epicenter sync --watch --json` for as long as it
runs, and restarts it whenever a folder is added, cloned, or forgotten
(`apps/epicenter/src-tauri/src/synced_folders.rs`). The CLI's stop handler
then ended every `git` it had started at once. A round stopped inside
`git merge` left `.git/index.lock` and the merge driver's `.merge_file_*`
scratch files in the folder, and every later round ended `retry` on the lock
until a person deleted it. Had the CLI waited, the three-second kill would
still have cut a long merge off and left `MERGE_HEAD` with no merge commit.

## Decision

**A stop signal lets a sync round under way finish, for up to a minute, and
the shell kills a CLI child only after it has waited longer than any grace
the CLI gives.**

```txt
packages/cli/src/stop.ts
  STOP_GRACE_MS = 2_000          a refresh's keychain write (ADR-0565)
  ROUND_GRACE_MS = 60_000        one folder's sync round and its report
  finishBeforeExit(work, grace)  a stop waits for work, work begun after the signal included
  isStopping()                   `epicenter sync` begins no round once it is true
apps/epicenter/src-tauri/src/cli.rs
  STOP_GRACE = 65 s              SIGTERM to the child's process group, SIGKILL after it
```

The stop's cleanups, `endGitCommands` among them, run after the unfinished
work settles or its grace runs out. A child with nothing unfinished exits at
once. The replacement watch's first round waits on the repository's
`epicenter-sync.lock` in its Git directory, for up to two minutes
(`TURN_WAIT_MS` in `packages/cli/src/sync/sync.ts`), so the stopped run and
the new one take turns.

A test holds `STOP_GRACE` above both graces:
`the_stop_grace_outlasts_every_grace_the_cli_gives_its_work` in `cli.rs`
reads both constants from `stop.ts`. The end-to-end test "a stop signal in
the middle of a merge lets the round finish" in
`packages/cli/src/sync/sync.e2e.test.ts` stops a desktop watch mid-merge with
the app's signal and finds no `MERGE_HEAD` or index lock, a clean tree, and
the merge commit pushed.

## Consequences

Adding, cloning, or forgetting a folder can leave the old watch running for
up to a minute while it finishes a round; the new watch's first round waits
that long on the lock. A round that outlasts `ROUND_GRACE_MS` is cut off
and leaves what a cut-off merge leaves, for a person to clear.

## Considered alternatives

- **The CLI waits for its round, and the shell keeps its three-second
  kill.** A merge longer than three seconds is still cut off, leaving
  `MERGE_HEAD` for a commit step that never runs.
