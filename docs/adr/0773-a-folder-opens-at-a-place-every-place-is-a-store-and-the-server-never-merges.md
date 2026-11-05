# 0773. A folder opens at a place, every place is a store, and the server never merges

- **Status:** Accepted (2026-11-05)
- **Date:** 2026-11-05
- **Amends:** [ADR-0700](0700-apps-share-data-through-a-file-contract-recorded-in-git.md) at "Notes merge by one set of rules, wherever a merge runs" and `settle` in the translator: the server never merges a write; [ADR-0766](0766-an-apps-capabilities-are-module-values-opened-synchronously.md) at `openFolder(contract, { site, account })` and its table of openers: an app opens its folder at a place, and `openRemote` is no opener; [ADR-0746](0746-the-web-is-online-offline-needs-an-installed-app.md) at "reads and writes the repository through `openRemote`": the repository is a place.
- **Relates:** [ADR-0767](0767-an-async-lifecycle-is-modeled-as-synchronous-state-actions-wait-on-their-own.md) (the folder's synchronous reads), [ADR-0770](0770-teams-own-repositories-and-sharing-is-membership.md) (teams), [ADR-0771](0771-plain-files-let-epicenter-refuse-renames-attachment-conflict-copies-and-a-second-store.md) (the later write to an attachment wins), [ADR-0772](0772-a-folder-says-what-it-is-in-agents-md-and-this-computer-keeps-the-rest.md) (a folder says what it is), [ADR-0620](0620-history-in-a-repository-only-grows.md) (a push is a fast-forward).
- **Amended by:** [ADR-0774](0774-one-write-makes-it-so-and-settles-a-change-the-way-sync-does.md) at the folder carrying an edit over a change with `updateNote`: it settles it with `settle`.
- **Unbuilt:** stale `openDataFolder` comments in `apps/whispering/src-tauri/src/main.rs` and `packages/tauri-epicenter-standalone/src/lib.rs`.

## Context

`@epicenter/folder` had three public layers: stores that hold bytes at
paths (memory, this browser's storage, the desktop's folder, a Node
directory), a typed client over them (`Client<T>`), and the folder an app
holds, which shows what the store holds and reconciles writes into it. The
server repository was the exception: `remote/client.ts` rewrote the whole
typed client over HTTP, so every rule about notes lived twice, and the
server merged a web write that raced another (decision 15) while the folder
already carried an edit over another writer's change (`updateNote`). Apps,
tests and scripts reached the layers below the folder (`openDevice`,
`openRemote`, `createFolder` over a client), and the recorder reached the
browser's store through a hidden key because the folder offered no
`append`.

A prototype (branch `claude/pass2-repository-store`) put the repository
behind the store's shape: a create refused where a file is, inside the
server's compare-and-swap; a listing that carries each file's version from
the tree, so no attached file is downloaded to list it; and every server
answer mapped to a store's `landed` or `stale`. The existing remote tests
passed through both paths.

## Decision

**An app opens its folder at a place.** One verb, and the place is a value:

```ts
export const folder = openFolder(todos, home({ site: APPS.TODOS.url, account }));
openFolder(todos, directory('/tmp/todos'));   // @epicenter/folder/node: scripts and tests
```

`home` is the app's own place, which the build picks: the desktop's folder
for the app (ADR-0772), this browser's storage with no account, the
account's team's repository with one, and memory under `test`. A place is
opaque: nothing outside the package writes one.

**Every place is a store, under one typed client.** Memory, this browser's
storage, the desktop's folder, a Node directory, and the server repository
answer the same five operations (list, read, write over a version, watch,
and append where they can), and one internal client gives them the
contract's notes and files. `Client`, `createFolder`, `openDevice`, and
`openRemote` are not public; the folder is what an app, a test, or a script
holds.

**The server never merges.** A web write made over a version the
repository no longer holds is refused, as a device store refuses one; the
folder then carries the person's edit over the change (`updateNote`) and
writes again. Desktop sync merges on the desktop and pushes a fast-forward.
Every merge runs on the computer of the person writing.

**A file collection appends where its store can.** This browser's storage
appends, so a recording is written as it records through
`folder.audio.append`; elsewhere `append` answers `Unavailable`.

**An app owns one folder.** Only the Epicenter app and agents read or write
across folders. A desktop page reaches only the roots its shell names, so a
later app that needs another's folder is one more root named in its shell,
with no permission system.

## Consequences

- One rule set for notes, one client, and five stores; `remote/client.ts`
  (541 lines) goes for a 208-line store.
- An update over the web is exact: the version it carries is checked where
  it lands, one request fewer, with no "landed merged" case.
- Scripts and tests open a folder over a directory instead of building one
  from a client.
- A Node program that wants a fresh read of one note uses the folder's
  `list()`; nothing reads below the folder.
- The repository has no `append`; a recording on the web keeps its audio in
  this browser's storage.
