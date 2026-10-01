# 0474. Incoming file-folder sync is an explicit clean fast-forward

- **Date:** 2026-10-01
- **Status:** Proposed
- **Implementation:** explicit clean fast-forward adoption and a real browser/native round trip through the loopback Git HTTP remote.
- **Unbuilt:** released application integration and production remote transport.
- **Related:** [File authority](0450-current-files-own-portable-document-data.md), [Partial file operations](0467-interrupted-file-operations-report-partial-results.md), [Independent saves and history](0468-file-saves-succeed-independently-of-automatic-commits.md), [Folder handle](0471-a-data-folder-handle-exposes-tables-kv-and-files.md)

## Context

File saves, local commits, and outgoing pushes have separate outcomes. A device
can keep saving and committing when a push fails. Adopting another device's
commits is a separate operation because it can replace the current files that
table and KV readers use.

Writing Git conflict markers into Markdown frontmatter or `kv.json` can make
those readers unusable. Automatically choosing a winner would also introduce a
data-loss policy that the current folder API has not established.

The first Todos demo needs a real browser-to-native round trip. It does not need
a browser merge editor, automatic conflict resolution, or remote device backup
branches. The user chose to keep local commits waiting when shared sync is
blocked by a conflict.

## Decision

The folder exposes explicit `git.fetch()` and `git.pullFastForward()` operations.
Fetch transfers Git objects and observes remote refs without changing authored
files. `pullFastForward()` fetches, pins the incoming commit, and attempts to
adopt it only when the current portable folder and staging index are clean and
the incoming commit descends from the local HEAD. A new empty folder may adopt
its first incoming commit after the same destination checks.

Opening a folder, refreshing status, focusing the app, and pushing do not pull.
Local commits continue when incoming adoption refuses. A subsequent explicit
attempt evaluates the current files and Git refs again.

Before replacing any authored bytes, the implementation checks ancestry,
literal path representability, file-versus-directory collisions, and native
case collisions. Dirty files, staged changes, divergence, and unsupported paths
refuse adoption without publication. Readable Markdown with conformance issues
remains eligible; incoming adoption does not require every row to satisfy its
table schema.

Incoming files use the folder's ordinary conditional file boundary. The branch
advances last through a real compare-and-swap against the inspected local HEAD.
An IndexedDB implementation can combine its file changes and ref update in one
transaction. Native publication can stop after some filesystem steps. It must
report applied paths and the observed HEAD outcome, as described by ADR 0467.
It must not claim that a preflight check makes native publication atomic, or
roll back files over a competing writer after a branch-update failure.

Native staging-index changes use native Git's locking protocol. An in-process
JavaScript mutex does not protect `.git/index` from other native Git processes.
Git coordination covers Git work; ordinary app file edits do not acquire an
application-wide editing lock.

## Consequences

The first implementation needs no merge algorithm, conflict-marker storage,
AI resolution service, recovery journal, scheduled retry, or device-branch
backup queue. The app can show that incoming changes require attention while
continuing local editing.

A divergent history remains unresolved until someone resolves it with Git
outside this browser API. Waiting does not eliminate the conflict or back up
unpublished local commits. This limited incoming operation is sufficient for
the sequential browser/native demo; broader consumer sync needs a later,
explicit decision about resolution and recovery.

## Verification

- Browser and native commits round-trip through a real Git HTTP remote.
- A dirty file or staged change refuses adoption without changing files or HEAD.
- Divergent histories refuse adoption while preserving local commits and files.
- Invalid authored Markdown transfers without generated conflict markers.
- Native interrupted publication reports actual partial effects.
- A competing branch update prevents stale ref replacement.
