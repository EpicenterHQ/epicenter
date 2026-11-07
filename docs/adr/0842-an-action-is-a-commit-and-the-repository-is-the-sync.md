# 0842. An action is a commit, and the repository is the sync

- **Status:** Proposed
- **Date:** 2026-11-07
- **Relates:** [ADR-0841](0841-an-app-is-a-folder-whose-epicenter-ts-defines-its-actions.md) (an app is a folder, each its own repository), [ADR-0840](0840-epicenter-is-where-one-persons-software-lives-and-the-folder-sync-product-waits.md) (the direction).
- **Spec:** [specs/20261107T222922-epicenter-is-where-personal-software-lives.md](../../specs/20261107T222922-epicenter-is-where-personal-software-lives.md)
- **Unbuilt:** all of it: committing after an action, undoing a failed one, one action per app at a time, `epicenter sync`, and the Epicenter Cloud file API.

## Context

Each app folder is its own Git repository (ADR-0841). An app's data changes in
two ways: an action writes it, or the person edits it by hand. It has to reach
the person's other computers, and, later, pages that cannot run Git: a page on a
phone, or a site someone else built for an app. Records 0802 to 0839 answered
this with a server ledger and a sync engine; ADR-0840 set those aside.

## Decision

**The repository is the sync.** Each app's repository is where its data lives,
each computer holds a working copy, and a remote is where copies meet.

**An action is a commit.** When `run` returns, everything it changed in the
app's folder becomes one commit whose message names the action and its input;
on a computer, Epicenter finds the changes by comparing the folder before and
after, so writes through `path` count too. When `run` throws, its changes are
undone. Epicenter never stages a path an action did not change; the person
commits their own edits.

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
- **A page reaches GitHub directly.** GitHub's Git endpoints refuse calls from a
  page, and its tokens are not scoped to one folder the person signs in for.
- **A server ledger.** ADR-0837's design; it serves many people and devices,
  which ADR-0840 set aside.

## Consequences

- An app's history is a readable list of what its actions did.
- A computer and a page behave alike: one action, one commit.
- Hand edits travel only once the person commits them; `epicenter sync` says
  when some have not.
- Nothing without Git works until Epicenter Cloud exists; nothing needs it
  until the phone does.
