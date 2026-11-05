# 0794. A sync round asks its host to settle, checks out only what did not move, and retries rather than guess

- **Status:** Accepted (2026-11-05)
- **Date:** 2026-11-05
- **Amends:** [ADR-0751](0751-every-native-app-carries-one-sync-core.md) at "the plugin runs a round at the moments" and "a working-tree recheck before merge": the shell owns an app's moments while the core stays, a round's settle is answered by a live page of the app, and checkout writes only what did not move; [ADR-0787](0787-records-that-assumed-a-running-engine-or-a-build-time-choice-follow-0750-and-0781.md) at "The core runs it in a round": the core asks its host; [ADR-0774](0774-one-write-makes-it-so-and-settles-a-change-the-way-sync-does.md) at "the Git LFS object id of any other file, on every store": a store names a file other than a note by a stamp, keeping its object id beside it.
- **Relates:** [ADR-0750](0750-sync-is-like-save-any-program-can-sync-a-folder-and-none-owns-it.md) (the moments), [ADR-0793](0793-programs-only-compose-typescript-holds-what-epicenter-means-and-rust-holds-the-os-git-and-secrets.md) (one `settle`, in TypeScript), [ADR-0775](0775-a-write-never-fails-the-folder-keeps-it-until-it-lands.md) (a note that does not read), [ADR-0789](0789-a-conflict-is-a-mark-on-its-note-resolved-in-the-repair-editor.md) (conflict marks), [ADR-0733](0733-your-own-git-in-an-epicenter-folder-is-plain-git.md) (plain Git).
- **Amended by:** [ADR-0795](0795-git-merges-a-notes-body-and-epicenter-merges-its-front-matter-by-key.md) at a round asking its host to settle and a round with no live page: a round merges by itself.
- **Amended by:** [ADR-0801](0801-records-from-0763-to-0800-agree-on-the-merge-rust-patching-marks-and-agents.md) at the checks before a local repository: no rquickjs spike or QuickJS; the iOS spike asks whether a native round finishes in the background.
- **Amended by:** [ADR-0802](0802-people-share-spaces-an-app-works-in-one-at-a-time-and-a-folder-carries-its-contract.md) at the founder's decision on a local repository: the lean is a plain folder, which the prototype confirms or refutes.
- **Amended by:** [ADR-0803](0803-clients-sync-only-with-epicenter-servers-and-sync-is-a-function-of-two-stores.md) at the store-to-store prototype: it is `sync(local, remote, manifest)` over the store contract.
- **Amended by:** [ADR-0804](0804-a-computer-keeps-a-plain-folder-and-every-surface-syncs-with-one-typescript-function.md) at checkout, rounds, shell moments, and the open decision: there is no checkout or round, moments live in the sync package, and the decision is made.
- **Unbuilt:** all of it: a failed or unanswered settle ending the round `retry` (it is `stopped` in `packages/epicenter-core/src/merge.rs:90`); the core passing the contract's keys to `settle` (`packages/epicenter-core/napi/index.ts`), with a test that a round and a page settle the same edits identically; one batched settle per round; checkout through the version-checked put, after merging `epicenter-folder-core` into the core; the partial-checkout test in `tests/round.rs`; the shell's moments and a round with no live page; the iOS background spike and the rquickjs spike; the store-to-store prototype.

## Context

An adversarial review read the sync core and the folder engine and found that
the core's checkout writes merged files with plain file writes
(`packages/epicenter-core/src/worktree.rs`) after the comment "a real core
would re-snapshot here" (`src/lib.rs`), so an edit landing during a round, a
take or an agent's change, can be overwritten. It found that the core calls
`settle` without the contract's keys while the page passes them, so the two
lay out one merge differently; and that a settle that fails ends the round
`stopped`, which tells a person to act. It also asked what a round does when
no page is alive to settle, and what is promised about the folder's Git
repository.

The review tested, and rejected, merging only between computers: an open
editor holds text begun from an older version, so saving it as a plain
replacement would erase a paragraph another device added since. ADR-0774's
rule stands: named fields take the write; a body or whole text is settled
against what the folder showed when the change began; a whole-file write and
a take apply as they are.

## Decision

**Merging happens wherever text begun from an older version meets a file
that moved: in a round, and in a body or whole-text write.** A field is an
intent applied to the file as it is. Nothing else merges.

**A round asks its host to settle.** It hands every note both sides changed,
the set the core already builds and not only what libgit2 reports as
conflicts, to its host in one batch, with the contract's keys: Bun in the
CLI, and a live page of the app in a desktop app, preferring the window
whose moment started the round. A settle that fails or goes unanswered ends
the round `retry` before `MAIN` and `LAST_SEEN` move, within a bound under
the round lock's wait.

**Checkout writes only what did not move.** It writes each file through the
version-checked put the page's writes use. A file changed since the round
began is left as it is, and the round ends `retry` before `MAIN` and
`LAST_SEEN` move; the next round commits that file and settles it in the
ordinary merge. A file another program writes between the check and the
rename is the one loss no design closes while programs write plain files
without a lock; history holds what a round committed. A writer that keeps
saving can hold rounds in `retry`, and each still commits its new files.

**A round with no live page commits and fetches,** and finishes when its
merge needs no settle. When it needs one, it ends `retry` before merging and
moves nothing.

**Moments are the shell's while the core stays.** Every save passes through
the shell, takes it places included, and it sees the window come back; the
page gives it the credential and the team as values. App code names no
moment (ADR-0753).

**A store names a note by its Git blob id.** A file other than a note keeps a
stamp, with its Git LFS object id beside it, so a listing never reads a
recording.

**A local repository waits on two checks and a decision.** The positioning
promises "Git history beside it" and "syncs over plain Git with a server you
choose" (`docs/positioning.md`). Before the core is linked into every app,
an iOS spike shows whether a round must finish while the page is suspended,
and an rquickjs spike builds the core with the bundled `settle`. If a round
must finish without a page, the core stays and runs `settle` in an embedded
QuickJS. Otherwise the founder decides whether those promises hold, judged
against a store-to-store prototype in TypeScript that syncs a folder with
the repository through the stores the folder already has, timed on an
unchanged round of 10,000 items and run through the existing scenarios.

## Consequences

- An edit made during a round survives, except in the window between a
  checked put's check and its rename.
- A round and a page settle the same edits the same way.
- A closed window or a reload costs a round, never a change.
- The fixes to `retry`, keys, and checkout come first, because the CLI runs
  the core today.
- `tauri-plugin-epicenter` waits for the spikes and the decision.

## Considered alternatives

- **Merging only between computers:** an editor's save would replace a body
  another device changed since the editor began.
- **Settling again at checkout:** needs `settle` at any point of a round and a
  protocol that loops; keeping the file and retrying needs neither.
- **Pushing everything but the notes that need settling:** a merge commit
  takes both sides whole, so the next round would revert one.
- **QuickJS in the core now:** about 1 MB in every app, before a spike shows
  a round must finish without a page.
