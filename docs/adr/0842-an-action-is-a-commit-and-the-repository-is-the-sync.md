# 0842. An action is a commit, and the repository is the sync

- **Status:** Accepted (2026-11-07)
- **Date:** 2026-11-07
- **Relates:** [ADR-0841](0841-an-app-is-a-folder-whose-epicenter-ts-defines-its-actions.md) (an app is a folder, each its own repository), [ADR-0840](0840-epicenter-is-where-one-persons-software-lives-and-the-folder-sync-product-waits.md) (the direction).
- **Spec:** [specs/20261107T222922-epicenter-is-where-personal-software-lives.md](../../specs/20261107T222922-epicenter-is-where-personal-software-lives.md)
- **Amended by:** [ADR-0848](0848-the-runner-owns-only-what-an-action-wrote.md): an action's commit and undo cover only the paths it wrote, guarded by a record of each write's hash. [ADR-0846](0846-epicenter-owns-no-infrastructure-and-each-repository-has-one-meeting-point.md): each repository has one meeting point, and nothing merges in the folder that runs actions.
- **Unbuilt:** the Epicenter Cloud file API. The rest is built in `packages/cli` (`run.ts`, `sync.ts`), which also refuses an action while its repository is in the middle of a merge, since the commit could not be made.

## Context

Each app folder is its own Git repository (ADR-0841). An app's data changes in
two ways: an action writes it, or the person edits it by hand. It has to reach
the person's other computers, and, later, pages that cannot run Git: a page on a
phone, or a site someone else built for an app. Records 0802 to 0839 answered
this with a server ledger and a sync engine; ADR-0840 set those aside.

## Decision

**The repository is the sync.** Each app's repository is where its data lives,
each computer holds a working copy, and a remote is where copies meet.

**An action is a commit, and never the person's edits.** Before `run`, Epicenter
notes the paths that already have uncommitted edits. A `folder.write` to one of
them throws. When `run` returns, every path that changed in the folder, through
the methods or through `path`, becomes one commit whose message names the action
and its input, except the noted paths: one of those changed through `path` stays
uncommitted, and the result names it. When `run` throws, Epicenter undoes only
the changed paths that were clean before; it never resets the folder. Writes
outside the folder (Mail saving attachments into the vault) belong to that
repository and are never committed; the return value names them. The person
commits their own edits.

**Exit codes say whether `run` started; the error says what to do next.** 0: it
ran. 1: a finding (a `sync` conflict, uncommitted edits, a check that failed).
2: it did not run and nothing changed (usage, an unknown app or action, input the
schema refuses, a refusal before `run`). 3: `run` started and threw; the folder's
changes are undone, and effects outside it may have happened. With `--json`, an
error is `{"error":{"code":"usage"|"failed"|"needs_person","message":…,"next":…}}`,
where `next` is the command to run (`epicenter mail connect`). This changes
[ADR-0520](0520-the-cli-acts-on-a-data-folder-by-its-path.md)'s meaning of 2,
which today also covers a thrown error.

**Actions on one app take turns.** One action per app runs at a time; different
apps run in parallel.

**`epicenter sync` pulls and pushes every app repository under the home, and
never commits.** It merges with Git's merge, says which apps have uncommitted
changes, and leaves conflicts as markers in the file for the person or an agent.
An app marks files that only grow (a chat, a log) `merge=union` in its
`.gitattributes`, so two devices adding lines never conflict. An app with no
remote gets one when the person adds any Git remote, or, signed in, on Epicenter
Cloud.

**A computer reaches a repository through Git, on any host. Anything without
Git reaches it only through Epicenter Cloud**: a file API over Cloudflare
Artifacts that reads, lists, and writes, refuses a write when the file changed
since it was read, commits an action's writes as one commit, and accepts a token
for one app's repository issued through Epicenter's sign-in.

## Considered alternatives

- **Epicenter commits everything on a timer.** Sweeps half-finished hand edits
  into commits, against the vault's stage-by-path rule.
- **`epicenter sync` commits before pulling.** The same sweep, at a moment the
  person chose for a different reason.
- **Comparing the whole folder before and after, and committing every change.**
  Sweeps the person's open edits, and a concurrent agent's, into the action's
  commit.
- **Refusing any action that uses `path` while the folder has uncommitted
  edits.** Blocks routine runs whenever the person has unrelated edits open.
- **Exit 2 for a thrown error, as today.** An agent could not tell "fix the
  call" from "it ran and failed, and Gmail may have changed".
- **A page reaches GitHub directly.** GitHub's Git endpoints refuse calls from a
  page, and its tokens are not scoped to one folder the person signs in for.
- **A server ledger.** ADR-0837's design; it serves many people and devices,
  which ADR-0840 set aside.

## Consequences

- An app's history is a readable list of what its actions did.
- A computer and a page behave alike: one action, one commit.
- Hand edits travel only once the person commits them; `epicenter sync` says
  when some have not.
- A clean file edited by hand while an action runs is swept into that action's
  commit; actions on one app take turns, so the window is one action long.
- Nothing without Git works until Epicenter Cloud exists; nothing needs it
  until the phone does.
