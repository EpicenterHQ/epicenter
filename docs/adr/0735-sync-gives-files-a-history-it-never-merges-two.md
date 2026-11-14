# 0735. Sync gives files a history; it never merges two

<!-- doc-path-check: ignore-file (cites the waiting folder sync product (ADR-0840), kept at tag folder-sync-product) -->

- **Status:** Accepted (2026-11-04)
- **Date:** 2026-11-04
- **Amends:** [ADR-0721](0721-an-apps-folder-is-derived-never-stored.md) at "Cloning where a folder already exists, as when an app on a second Mac made its folder first, joins it: fetch, then merge": the folder's files are added on top of the account's repository in one commit; [ADR-0700](0700-apps-share-data-through-a-file-contract-recorded-in-git.md) at "the `.gitattributes` block `epicenter init` commits" and "A folder `epicenter init` has not registered has no history": a folder has no history until its first sync, whose one commit holds the attribute block.
- **Amended by:** [ADR-0761](0761-sync-never-merges-two-unrelated-histories.md) at the title's principle, "it never merges two": it reads "it never merges two unrelated histories", and offline commits on a folder Epicenter already synced merge as branches of one history.
- **Relates:** [ADR-0734](0734-every-file-other-than-a-note-is-kept-whole-in-git-lfs.md) (how a file on both sides merges), [ADR-0546](0546-a-folder-syncs-to-git-epicenter-so-under-its-owners-namespace-and-the-first-push-creates-it.md) (the first push creates the repository), [ADR-0620](0620-history-in-a-repository-only-grows.md) (history only grows), [ADR-0715](0715-the-epicenter-app-browses-every-folder-and-document-a-person-has.md) (the consent screen).
- **Unbuilt:** the consent screen's counts ("This Mac's 12 recordings will be added to your Whispering, which has 340").

## Context

Apps write files and never commit
([ADR-0700](0700-apps-share-data-through-a-file-contract-recorded-in-git.md)).
No app creates a repository: `packages/folder` runs no `git init`, and the
Epicenter app reaches Git only by running the CLI's `init`
(`apps/epicenter/src-tauri/src/synced_folders.rs`). `epicenter init` in
`packages/cli/src/sync/setup.ts` runs `git init -q -b main` and commits
`.gitattributes` and `.gitignore` as "epicenter: attributes and ignore
rules", so a folder gets a history of its own before it ever meets the
account's repository.

That history is why sync merges two histories today. On a folder's first
round, `merge` in `packages/cli/src/sync/sync.ts` passes
`--allow-unrelated-histories` (`firstContact`, "decision 20" in its comment),
joining the folder's one-commit history to the account's. Git has refused
that merge by default since 2.9, because two unrelated histories usually
mean two different projects.

`epicenter clone` onto a folder that already holds files joins it
(`joinExisting` in `packages/cli/src/sync/clone.ts`). Without `--join` it
joins only when a heuristic passes: the folder's `AGENTS.md` names the same
contract (`sameContract`), the repository's name is the one the contract's
site derives (`expectedName`), and the remote is in the person's own
namespace (`ownsRemote`). A join then merges without publishing, sets
`epicenter.joinPending`, and waits for an explicit `epicenter sync` to
publish (`publish: false`, `allowPending`). A person on a second Mac sees
three steps for one intent: put this Mac's recordings in my Whispering.

## Decision

**A folder has no history until it first syncs.** No app and no Epicenter
command creates a repository or a commit before that. `epicenter init`
writes Epicenter's blocks of `.gitattributes` and `.gitignore` and commits
nothing.

**Turning on sync builds the folder's history on top of the account's
repository for that app.** When the repository exists, its `main` is the
base, and the folder's files are this machine's changes on top of it:

| A file that is | Becomes |
| --- | --- |
| only in the account's repository | checked out into the folder |
| only in the folder | an addition |
| in both | merged by [ADR-0734](0734-every-file-other-than-a-note-is-kept-whole-in-git-lfs.md)'s rule: a note by `settle` with an empty base, any other file kept whole with both versions |

Sync then makes one commit, "Added from <computer name>", on top of the
repository's `main`, and pushes it. When the account has no repository for
the app, that commit is the first, and the push creates the repository
([ADR-0546](0546-a-folder-syncs-to-git-epicenter-so-under-its-owners-namespace-and-the-first-push-creates-it.md)).

**Turning on sync is the one consent.** The screen states what it does in the
app's own collection names:

```txt
This Mac's 12 recordings will be added to your Whispering, which has 340.
```

Restore on a machine with no folder is the same act with nothing to add: the
repository is checked out at the app's derived path.

**Sync never merges two unrelated histories.** `--allow-unrelated-histories`,
the join heuristic, `epicenter.joinPending`, and the `publish` and
`allowPending` options are removed, and so is `--join`: cloning onto an
occupied folder is itself the consent to sync it with that remote, and the
folder's files go on top of that remote's `main` the same way.

**A folder whose Git history Epicenter did not make is refused.** A folder
that already has a `.git` because the person or another tool ran `git init`,
or that tracks a different remote, is never joined to the account's
repository. Epicenter syncs it only with its own existing `origin`. The
refusal names the Git command that resolves it:

```txt
~/Epicenter/whispering already has its own Git history.
To add its files to your Whispering: mv ~/Epicenter/whispering/.git ~/Epicenter/whispering/.git-before-epicenter
To sync it with its own remote instead: git -C ~/Epicenter/whispering remote add origin <url>
```

## Consequences

- Every synced folder's history descends from the account repository's first
  commit, so two machines never hold unrelated histories of one app.
- A second machine's files arrive as one commit a person can read in
  `git log` and revert as a unit.
- The CLI loses `joinExisting`'s heuristic, one Git configuration key, and two
  sync options.
- A folder with history of its own cannot be added to the account's
  repository until the person moves that history aside; its old commits do
  not travel.
- The first sync fetches before it commits, so it needs the network; a
  folder never synced keeps working locally with no history at all.

## Considered alternatives

- **Merge unrelated histories on first contact (today).** Two roots in every
  joined repository, and a merge Git refuses by default.
- **Join implicitly when a heuristic passes, publish later (today's `clone`).**
  A person sees join, merge, and publish as three steps, and the heuristic
  decides for them.
- **Rebase the folder's history onto the account's.** Replays commits that
  exist only because `init` made them.
- **Replace the account's files with the folder's.** Loses the recordings
  the other machine made.
