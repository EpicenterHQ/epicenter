# 0741. Epicenter reconciles only states it made

- **Status:** Accepted (2026-11-04)
- **Date:** 2026-11-04
- **Amends:** [ADR-0719](0719-every-change-to-the-data-model-is-checked-against-eight-principles.md) at principle 8, "Where a guarantee is weaker, the screen says so": it becomes "Epicenter reconciles what it made; anywhere else, the screen says what it found and the command that fixes it."
- **Relates:** [ADR-0735](0735-sync-gives-files-a-history-it-never-merges-two.md) (a folder with its own history is refused), [ADR-0733](0733-your-own-git-in-an-epicenter-folder-is-plain-git.md) (your own git is plain Git), [ADR-0726](0726-an-apps-path-is-its-claim.md) (a failed open shows the error with Retry).
- **Unbuilt:** a refusal with a command for each state in the second table that does not already have one.

## Context

Principle 8 of ADR-0719 says the screen states a weaker guarantee: "On this
browser", "Not synced", a refused document copy. It does not say which
states Epicenter should repair and which it should only report.

Much of the sync code handles states that only a person or another tool
creates. `merge` in `packages/cli/src/sync/sync.ts` joins a folder's own
history to the account's with `--allow-unrelated-histories`, and
`joinExisting` in `packages/cli/src/sync/clone.ts` decides by heuristic
when to join a folder with files (both removed by
[ADR-0735](0735-sync-gives-files-a-history-it-never-merges-two.md)). Other
states are already refused with a message: a branch other than `main`
(`repositoryProblem` in `packages/cli/src/sync/repository-state.ts`), a
remote `main` that no longer contains `refs/epicenter/last-seen`
(`sync.ts`, which names the `git rebase --onto` and `git update-ref` to
run), and a folder inside another repository (`init` in
`packages/cli/src/sync/setup.ts`).

Each reconciliation costs code and tests for a case Epicenter cannot
predict. A refusal that names the state and the exact command costs one
message. A person who does not use a terminal can still act on it: their
agent can run the command.

## Decision

**Epicenter reconciles the states it made.**

| State | Made by | Epicenter |
| --- | --- | --- |
| files an app wrote | an app | commits and syncs them |
| edits made offline | an app or a person, on Epicenter's history | merges them by [ADR-0734](0734-every-file-other-than-a-note-is-kept-whole-in-git-lfs.md)'s rule |
| a folder's first history | Epicenter's first sync | builds it on the account's repository (ADR-0735) |
| a link Epicenter created | `epicenter move`, `epicenter link` | follows it, and moves or removes it |
| a dead link, an unplugged drive | a link Epicenter created | says so, with Retry |

**A state something else made is refused, with what Epicenter found and the
command that resolves it.**

| State | Example refusal |
| --- | --- |
| a folder with its own Git history | `mv <folder>/.git <folder>/.git-before-epicenter` (ADR-0735) |
| a remote on another Git host | synced only with that remote; anything else is refused |
| a branch other than `main` | `git checkout main` |
| a remote `main` rewritten since the last sync | `git rebase --onto origin/main <last seen>`, then `git update-ref refs/epicenter/last-seen origin/main` |
| a repository nested in another | move the folder out of the enclosing repository |

Principle 8 of ADR-0719 reads: **Epicenter reconciles what it made; anywhere
else, the screen says what it found and the command that fixes it.**

## Consequences

- A review of a sync change asks who made the state it handles. Code that
  reconciles a state Epicenter did not make is replaced by a refusal.
- A person sees more refusals for folders they set up by hand, and each one
  carries the command.
- The screen states that are not refusals ("On this browser", "Not synced")
  stay; they describe a state Epicenter made.

## Considered alternatives

- **Keep principle 8 as written.** It explains labels for weaker guarantees
  and leaves open whether Epicenter repairs a state or reports it.
- **Reconcile every state Epicenter can detect.** Each case is code and tests
  for states Epicenter cannot predict, and an automatic repair of a state a
  person made can undo what they meant.
