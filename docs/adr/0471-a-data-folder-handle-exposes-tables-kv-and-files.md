# 0471. A data folder handle exposes tables, KV, and files

- **Status:** Proposed
- **Date:** 2026-09-30
- **Relates:** [ADR-0450](0450-current-files-own-portable-document-data.md) defines authoritative current files; [ADR-0456](0456-a-markdown-row-owns-at-most-one-same-stem-attachment.md) defines attachment ownership; [ADR-0430](0430-define-store-declares-data-and-products-compose-resources.md) separates stores from product composition.
- **Unbuilt:** the file-backed folder handle, raw file access, and migrated table/KV callers.

## Context

Current Local and Personal stores expose `tables`, `kv`, `sqlite`, `persistence`,
`signal`, and `close()`; Local also exposes `blobs`. Their tables still read a
Yjs document. The file-authoritative direction needs typed table access and raw
file access to the same saved data, including source an application cannot parse.
An aggregate application handle would also collect recording, inference, and
secrets despite those resources having independent owners.

## Decision

**One opened data folder exposes `tables`, `kv`, and `files` over the same current
logical file set.** `folder` below is a caller's variable, not a new constructor
or an aggregate application handle.

```ts
// Target file-backed API, not the current Yjs store API.
const recordingResult = await folder.tables.recordings.get('interview');
const sourceResult = await folder.files.read('recordings/interview.md');
const audioResult = await folder.files.open('recordings/interview.opus');
```

| Member | Responsibility |
| --- | --- |
| `tables.<name>` | Interpret that table's Markdown rows. `list` and `get` return captured entries; `update` and `writeSource` submit edits against an entry. |
| `kv` | Interpret declared root settings saved in `kv.json`. |
| `files` | Enumerate literal paths and read bytes, including uninterpreted files and attachments. `open` captures version-matched media under ADR-0466. Managed writes use the same file boundary as table and KV edits. |
| `signal`, `close()` | Expose the folder owner's lifetime. Closing fences its borrowed views and preserves saved files. |

**Closing aborts the owner's signal and fences new operations immediately, then
settles admitted storage work and cleans acquired resources asynchronously.**
`signal` is a readonly `AbortSignal`; it reports retirement, not file changes,
save success, or synchronization. `close(): Promise<void>` is terminal and
idempotent: repeated calls share the same completion or cleanup failure.
Retained table, KV, and file methods refuse new work once closing starts.
Closing does not delete files, roll back published changes, or acquire a global
writer lock. It reports the actual progress of admitted file operations.

The product owns workflow cancellation across independent resources. It can
use the folder's signal to stop inference that depends on that folder; passing
the signal does not make arbitrary external inference folder-owned work that
`close()` must await. A separate caller signal can cancel one operation without
closing the folder. Network push and commit cancellation remain part of their
own lifecycle contract.

Definitions, owners, entries, and opened content have different roles:

| Object | Acquisition and lifetime |
| --- | --- |
| `defineStore(...)` / `defineTable(...)` | Inert schema declarations; acquire no resources and need no close. |
| Opened folder | Owns the acquired file access and its borrowed table/KV views; exposes `signal` and `close`. |
| Table entry / `FileRef` | Captured source or address/version data; no methods, signal, or close. |
| Opened media | Bytes and version captured together. A temporary native capture needs a consumption and cleanup boundary under ADR-0466. |

`table.get` and `table.list` return observations, not live documents.
`table.update` and `table.writeSource` receive an observation and return the
accepted entry on success under ADR-0464. `files.open` opens content, not
another folder. Its eventual transport must account for temporary captures
until consumption finishes; a temporary-backed Blob alone supplies no cleanup
notification. No per-row resource handle is introduced to solve that problem.

**Table lookup takes a file stem; file access takes a literal path.**
`folder.tables.recordings.get('interview')` resolves `recordings/interview.md`.
An entry exposes this value as `stem`, with no separate identity registry.
Raw access includes directory and extension. The two forms are not aliases on
one overloaded lookup. A table named `files` lives at `folder.tables.files`
and does not collide with `folder.files`.

**A table directory contains Markdown rows, each owning zero or one non-Markdown
attachment with the same complete stem.** ADR-0456 supplies the exact extension
grammar, collision checks, and treatment of ambiguity and orphaned bytes.

```text
recordings/
  interview.md
  interview.opus
notes/
  meeting.md
  meeting.source.md
```

`interview.opus` belongs to `interview.md`. `meeting.source.md` is another row
with stem `meeting.source`, not an attachment of `meeting.md`. A same-stem `.md`
attachment would occupy the row's own path. A row may link to any number of
other files without owning them. The optional attachment's path is discovered
from the files rather than copied into frontmatter.

**Typed views do not hide or replace raw source.** A table declaration interprets
the Markdown; failed interpretation leaves the file accessible through `files`.
Table entries retain source and issues under ADR-0462. Table writes preserve
unrelated source under ADR-0464. Raw writes can create malformed documents or
break a same-stem pair; inspection reports that state without deleting bytes or
silently repairing references. App creation, deletion, and rename carry the
ownership requirements of ADR-0456 and ADR-0457.

Recording, inference, secrets, and account transport remain independently
composed product resources. This namespace decision does not replace current
store-owned SQLite under ADR-0436 or settle its migration. The generated root
`index.sqlite3` under ADR-0463 remains derived data. Constructor names, raw write
signatures, creation and rename signatures, partial-result reporting, and the history
namespace remain implementation decisions. Save and Git completion follow their
own decisions, not the spelling of a path or the shape of this handle.

Opening validates acquisition, not every future file state. Each operation
observes current source; there is no mandatory watcher or synchronous row cache.
Literal access stays within the opened folder, refusing absolute paths and
parent or symlink escapes. The raw inventory must account for unrecognized
files; portability and history inclusion are separate filters.

The remaining method contracts are bounded work, not implied APIs: table
creation/deletion/rename; raw enumeration and mutations; KV source, version,
issue and repair results; media consumption cleanup; and history/sync status.
Yjs `body`, `watch`, and `transact` methods are not carried over by symmetry.
The saved body is entry text, and native related-file operations may report
partial progress.

## Consequences

- Applications and file tools address the same source without importing edits
  into a second current document store.
- Table names cannot collide with resource namespaces. A product may open
  several folders and pass only the views a workflow needs.
- The one-attachment rule removes authored blob IDs and attachment paths for
  ownership. Multiple assets require other owning rows and links.
- External edits can leave ambiguous attachments or stale links. The folder
  preserves those files; supported app operations enforce their own admission
  checks and report partial results.

## Considered alternatives

- Put each table directly on the handle: a table named `files` or `close` would
  collide with folder capabilities.
- Require `.md` in table lookup: repeats a fixed format fact at every caller.
- Accept stems and paths interchangeably: introduces normalization and two
  spellings for one lookup.
- Restore one aggregate App handle: couples independent product resources to
  opening a data folder.
- Give every row an asset directory: supports arbitrary attachment names and
  cardinality, but adds a directory and asset-selection rules for the selected
  zero-or-one attachment contract.
