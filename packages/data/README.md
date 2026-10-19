# @epicenter/data

The browser repository engine under construction for
[ADR-0626](../../docs/adr/0626-an-app-reaches-a-repository-only-through-open.md)
and [ADR-0628](../../docs/adr/0628-browser-sync-uses-transactions-and-git-updates-instead-of-cross-tab-ownership.md).
Local implementation clarifications are recorded in
[ADR-0629](../../docs/adr/0629-a-local-save-refuses-a-file-directory-replacement.md),
[ADR-0630](../../docs/adr/0630-a-file-save-accepts-exact-bytes-as-its-starting-content.md),
and [ADR-0631](../../docs/adr/0631-a-browser-observes-the-remote-before-making-a-commit.md).
Current applications still use `@epicenter/folder`. The
[implementation plan](../../specs/20261019T190000-browser-repository-engine.md)
tracks transport, retention, app integration, and data-safe migration.

## Implemented locally

`src/repository.ts` opens the internal local engine. Files and rows save into
IndexedDB before returning success, including before an initial fetch. A row
retains its exact source and exposes raw fields with issues when the app's
read schema does not fit. Writes do not validate against that schema.

Each draft passes its starting source. A row save returns `sent`, the source
that draft submitted, for its next save. Other writers' independent fields
and body regions survive without becoming part of the draft's base.

IndexedDB owns publication:

```txt
capture refs, edits, required bytes and revision
                    |
          merge and hash outside a transaction
                    |
          compare revision in a write transaction
              /                         \
          changed                     matches
            |                            |
        recompute              publish and acknowledge
```

`src/storage.ts` stores inflated Git objects, B (last incorporated server
commit), C (that commit or one exact pending commit), E (newer text and
deletions relative to C), shallow-boundary metadata, and one repository
revision. Every mutation publishes atomically with a revision increment.
A push acknowledgement checks exact B/C and preserves newer E.
The persisted `remoteKnown` flag distinguishes an unopened remote from one
successfully fetched as empty. Preparation leaves E alone until that first
observation, then returns an exact pending `{ base, head }` pair or null.

`src/git/snapshot.ts` rebuilds changed trees without a checkout or Git index.
It preserves unrelated raw names, native modes, symlinks, and gitlinks.
`src/merge.ts` merges Markdown by frontmatter field and body region. Other
UTF-8 files, JSON included, merge by text region. Simultaneous insertions
survive current first; an edit beats an unseen deletion. A competing change
wins its field or text region. Invalid source stays available for file repair.

Local saves return `Occupied` if they would replace a folder with a file or
an ancestor file with a folder. This protects table rows and raw files through
the same check, including folders with names the app cannot decode. A witnessed
row deletion removes the row and its whole attachment folder together; the
folder follows the row, without a separate attachment-folder witness.

File operations accept a string or exact bytes as `from`. Use bytes from
the returned Blob to retain a leading byte-order mark or delete native binary
content. Changed content remains text only. Gitlinks remain structural entries
and are excluded from the file list; deletion does not claim an unseen gitlink
was removed. Writing text over a symlink or gitlink creates a regular file.
Untouched native modes and raw entries stay intact.

Closing a handle prevents new operations. A call made after close throws;
an already-running operation that cannot publish returns `StorageFailed`.
Previously acknowledged work remains saved.

## Integration boundary

The package has no public opening API yet. The internal constructor does not
check a grant or start network sync. Do not migrate an application to it until
the public `open`, auth, subscriptions, sync status, and automatic scheduling
are connected.

Git fetch/push, uncertain-push ancestry recovery, isolated fetch workspaces,
and collection remain unbuilt. The current object store therefore grows as
commits are prepared. Existing app data is untouched. Overwritten intermediate
local saves need not have a recoverable version; the eventual recovery
guarantee covers commits incorporated into server history.

## Verification

From the repository root:

```sh
bun run --cwd packages/data test
bun run --cwd packages/data typecheck
bun run --cwd packages/data smoke:local
```

The smoke check needs Playwright's Chromium, WebKit, and Firefox binaries.
Install them with `bun x playwright install chromium webkit firefox` when
needed. To use existing binaries, pass `--chromium <path>`, `--webkit <path>`,
and `--firefox <path>` to the smoke script. `--output <path>` records JSON.
Every run creates and removes its own temporary profiles and native Git
repository. It contacts only a temporary loopback server.

Unit tests use in-memory IndexedDB. The browser check runs the production
engine in two pages, races saves with commit publication, retains newer edits
after a simulated acknowledgement, reopens persistent profiles, and checks
the emitted objects with native Git. It does not exercise network sync,
forced browser termination, quota exhaustion, or a phone. Those require
separate evidence before release.

[Recorded results](evidence/local/RESULTS.md) include the current limitations:
snapshot capture still walks both complete trees and reads all pending edit
values. A 500-folder probe captures 502 trees for one file. Narrowing capture
is the next performance task; these measurements justify no pack cache or
per-edit base store.
