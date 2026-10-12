# 0471. A data folder handle exposes tables, KV, files, and Git

- **Status:** Accepted
- **Date:** 2026-09-30
- **Amended by:** [ADR-0518](0518-a-row-is-read-through-one-pipeline-and-repaired-as-text.md) and [ADR-0515](0515-snapshot-saves-serialize-writes-and-retain-only-the-latest-pending-text.md), replacing table snapshots with one read pipeline and the retained table editor with guarded edit sessions. Folder composition and ordinary table/file commands remain.
- **Amended by:** [ADR-0528](0528-folder-history-commits-every-save-and-has-no-manual-mode.md), proposed: withdraws `browser.commitOnEdit`, `git.commitOnEdit`, the shell-supplied commit policy, the snapshot's `commitOnEdit`, and the Todos CLI's manual history. The handle's members and its status snapshot remain.
- **Relates:** [ADR-0450](0450-current-files-own-portable-document-data.md) defines authoritative current files; [ADR-0480](0480-file-tables-own-only-their-markdown-row-files.md) defines single-file rows; [ADR-0430](0430-define-store-declares-data-and-products-compose-resources.md) separates stores from product composition.

## Context

Current Local and Personal stores expose `tables`, `kv`, `sqlite`,
`persistence`, `signal`, and `close()`; Local also exposes `blobs`. Their tables
still read a Yjs document. The file-authoritative direction needs typed table
access and raw file access to the same saved data, including source an
application cannot parse. An aggregate application handle would also collect
recording, inference, and secrets despite those resources having independent
owners.

## Decision

**One opened data folder exposes `tables`, `kv`, `files`, and `git` over the
same current logical file set.** `folder` below is a caller's variable, not a
new constructor or an aggregate application handle.

```ts
// File-backed API; Yjs store APIs remain separate.
const recordingResult = await folder.tables.recordings.get('interview');
const sourceResult = await folder.files.read('recordings/interview.md');
const audioResult = await folder.files.open('recordings/interview.opus');
```

| Member | Responsibility |
| --- | --- |
| `tables.<name>` | Interpret that table's Markdown rows. `get` returns a flat snapshot with usable fields and diagnostics; `list` returns one inventory of per-file Results; `inspect(source)` interprets draft text; `update(stem, change)` patches current source; `replace(snapshot, source)` saves complete text against a capture. `edit(stem, { signal })` opens a retained canonical editor with `get`, `subscribe`, `change`, `save`, `refresh`, `adopt`, and `dispose`. |
| `kv` | Interpret declared stored values in the fixed `kv.json`; applications own defaults. |
| `files` | Enumerate literal paths and read bytes, including uninterpreted files and media. `open(path)` supplies stable media bytes without a media version under ADR-0466. Intent-based mutations in ADR-0479 use the same file boundary as table and KV edits. |
| `git` | Observe history and outgoing synchronization status; explicitly refresh it, request commit-and-push attempts, fetch, adopt incoming history, and recover an interrupted adoption. |
| `location`, `onFilesChanged`, `terminal` | Identify the opened location, subscribe to invalidation hints, and open a shell over its files/history. |
| `signal`, `close()` | Expose the folder owner's lifetime. Closing fences its borrowed views and preserves saved files. |

The opener is `openFolder` from `@epicenter/folder` or an explicit adapter entry
under ADR-0478. Browser options select `browser.commitOnEdit`; the Bun directory
opener uses `git.commitOnEdit`; the Tauri shell supplies its policy. This
immutable runtime policy belongs to the opened owner, not saved content. It
controls implicit requests from that handle, not other writers. No commit
debounce duration is introduced. The native Todos CLI exercises manual history.

**The folder owns one observed Git status snapshot and delivers it to every
subscriber.** Files and Git hold durable facts; this snapshot caches the latest
observations and current attempt activity. It is not another durable store.

```ts
// Current API. See the package README for constructors and result types.
const unsubscribe = folder.git.subscribe(snapshot => {
  gitState = snapshot;
});
const statusResult = await folder.git.status();
const attemptResult = await folder.git.commitAndPush({ signal });
```

`subscribe(callback)` calls the callback synchronously with the latest snapshot
before returning an unsubscribe function, then delivers changed snapshots.
Before the first successful check, observations are unknown, not clean or
synchronized. A consumer can assign delivered snapshots to plain JavaScript
state or Svelte state. No separate `.current` getter or consumer-owned refresh
cache is required. Subscription does not itself request a scan or promise
continuous detection of external edits.

`status()` requests a fresh inspection, updates the shared snapshot, and returns
the inspection result. The folder owns one active scan and one pending scan;
requests during an active scan share the next scan so callers do not receive an
observation taken before their request. Known changes invalidate affected
observations. A superseded scan cannot overwrite newer observations with a false
clean result. Failed inspection preserves prior observations, marks them stale,
and exposes the failure.

The snapshot distinguishes observed uncommitted changes, local and remote commit
information, current activity, last attempt outcomes, and immutable
`commitOnEdit` policy. Consumers can distinguish manual mode from automatic
history failure. Observations carry check times and freshness independently of
activity. Starting a push does not refresh an old remote observation. Finishing
a scan does not itself request another scan. Notifications can therefore update
progress without repeatedly walking every file or accessing the network.

Open, focus, and explicit actions are refresh boundaries. Known saves and Git
changes mark observations stale or update them from evidence the operation
already obtained. External filesystem edits become visible on a later check; no
mandatory watcher or periodic polling is introduced. Raw Git staging state is
not an app editing draft: status uses the portable-source scope shared with
committing.

`commitAndPush()` awaits the outgoing attempt and reports its separate commit
and upload/push outcomes under ADR-0468. It does not save editor drafts or adopt
incoming changes. `git.fetch()`, `git.pullFastForward()`, the browser's
`git.mergeIncoming()`, and `git.recoverIncoming()` implement the explicit
incoming contract in ADR-0474; `git.snapshot.pendingIncoming` reports an
interrupted adoption. There is no `sync()` method or permission to merge
automatically.

**Closing fences new storage calls immediately; file operations own their
completion.** Closing aborts the owner's signal, stops hints, refuses new work,
and cancels owned network work. It then drains admitted Git work and releases
storage. It does not await file helpers or their publication replies. Await each
save whose completion is required before calling `close()`.

`signal` reports retirement, not file changes or save success. `close():
Promise<void>` is terminal and idempotent; repeated calls share its completion
or cleanup failure. A helper still reading or hashing may be refused at its next
storage call. An already-started publication returns its actual Result to that
operation's caller, including an operation-specific interrupted move or `Unconfirmed`. Closing does not
relabel it, roll back changes, or delete files. An admitted publication can finish after retirement. Await required saves before closing; storage ownership must remain valid until admitted backend work settles.

The product owns workflow cancellation across independent resources. It can use
the folder's signal to stop inference that depends on that folder; passing the
signal does not make arbitrary external inference folder-owned work that
`close()` must await. A separate caller signal can cancel one operation without
closing the folder. ADR-0468 defines settlement of admitted local Git work,
cancellation of outgoing attempts, and skipped pushes during close. Cancellation
does not prove the underlying work has stopped or establish a close deadline.

Definitions, owners, snapshots, and opened content have different roles:

| Object | Acquisition and lifetime |
| --- | --- |
| `defineFolder(...)` / `defineTable(...)` | Inert schema declarations; name no folder, acquire no resources, and need no close. |
| Opened folder | Opened at the folder ID its opener names. Owns acquired file access, borrowed table/KV/file views, and Git attempt/status coordination; exposes `signal` and `close`. |
| Table snapshot | Captured Markdown source, interpretation, and version for conditional writes; no methods, signal, or close. |
| Opened media | Stable bytes for consumption, with no required content hash or media version. A temporary native capture needs a consumption and cleanup boundary under ADR-0466. |

`table.get` and `table.list` return observations, not live documents.
`table.update` reads current source once; `table.replace` receives a captured
snapshot. Both return the published snapshot on success under ADR-0464 and never
retry a conflict. `files.open` opens content, not another folder. Its eventual
transport must account for temporary captures until consumption finishes; a
temporary-backed Blob alone supplies no cleanup notification. The canonical table editor owns a row draft, not a media capture; its disposal does not dispose referenced media.

**Table lookup takes a file stem; file access takes a literal path.**
`folder.tables.recordings.get('interview')` resolves `recordings/interview.md`.
A snapshot exposes this value as `stem`, with no separate identity registry. Raw
access includes directory and extension. The two forms are not aliases on one
overloaded lookup. A table named `files` lives at `folder.tables.files` and does
not collide with `folder.files`.

**A table snapshot interprets one Markdown file; media remains ordinary file
content.** ADR-0480 replaces attachment ownership: files can be anywhere within
the folder, linked through Markdown or application fields.

```text
recordings/
  interview.md
audio/
  interview.opus
notes/
  meeting.md
  meeting.source.md
```

`interview.md` may link to `../audio/interview.opus`. The link does not
authorize media deletion or rename. `meeting.source.md` is another row with stem
`meeting.source`. A row may link to any number of files without owning them. No
sibling scan discovers an attachment path.

**Typed views do not hide or replace raw source.** A table declaration
interprets the Markdown; failed interpretation leaves the file accessible
through `files`. Table snapshots retain exact source alongside `fields`, `body`,
`parseError`, and an always-present `issues` array under ADR-0462. Parsing
failure and field issues have separate stages; literal filenames produce no
conformance issues. Captured source replacement preserves submitted source under ADR-0464. Canonical editor saves publish the complete canonical document through `files.overwrite`; unknown keys remain, while YAML comments, spelling and order are rewritten. Raw
writes can create malformed documents or broken links; inspection preserves
those bytes without silently repairing references. Table creation, deletion, and
rename affect only the row file.

Recording, inference, secrets, and account transport remain independently
composed product resources. This namespace decision does not replace current
store-owned SQLite under ADR-0436 or settle its migration. ADR-0494 proposes
transient in-memory query sessions with persistent caching deferred; ADR-0463
defers SQLite query export. Neither adds SQL to this handle.
ADR-0479 records the raw
file mutation signatures. ADR-0478 records openers; ADR-0482 records individual publication and application workflow recovery; the package README and Git contracts record exact history result
types. Save and Git completion follow their own decisions, not the spelling of a
path or the shape of this handle.

Opening validates acquisition, not every future file state. Each operation
observes current source; there is no mandatory watcher or synchronous row cache.
Literal access stays within the opened folder, refusing absolute paths and
parent or symlink escapes. The raw inventory must account for unrecognized
files; portability and history inclusion are separate filters.

The public data API is summarized below. Error aliases retain the
underlying storage failures and add only method-specific preparation refusals.
Each async data operation in this inventory returns `Promise<Result<Success,
Error>>`; only pure `inspect` returns a plain reading. The package exports the reading and snapshot types shown below; the former
`Entry.content` wrapper is removed.

| Namespace | Call | Success data |
| --- | --- | --- |
| `tables.<name>` | `inspect(source)` | Plain `TableReading<T>` |
| | `get(stem)` | `TableSnapshot<T> \| undefined` |
| | `list()` | `{ path, result: Result<TableSnapshot<T>, TableReadError> }[]` |
| | `create({ stem?, fields, body? })` | `TableSnapshot<T>` |
| | `edit(stem, { signal? })` | Retained canonical editor |
| | `update(stem, { fields?, body? })` | `TableSnapshot<T>` |
| | `replace(capture, source)` | `TableSnapshot<T>` |
| | `rename(textCapture, nextStem)` | `TableSnapshot<T>` |
| | `delete(capture)` | `undefined` |
| `kv` | `inspect(source)` | Plain `KvReading<T>` |
| | `get()` | `KvSnapshot<T> \| undefined` |
| | `create(values)` / `update(values)` | `KvSnapshot<T>` |
| `files` | `list()` / `children(directory)` | Raw file inventory / direct child paths |
| | `read(path)` | `{ path, sha256, bytes }` |
| | `open(path)` | Stable `Blob` for consumption |
| | `create(path, content)` / `overwrite(path, content)` | `FileCapture` |
| | `replace(capture, content)` / `move(capture, destination)` | `FileCapture` |
| | `remove(capture)` / `mkdir(path)` / `rmdir(path)` | `undefined` |

`FileCapture` is `{ path, sha256 }`; `TextCapture` additionally contains exact
`source`. A table or KV snapshot can be passed to a raw captured mutation
because it has that metadata. Raw save receipts carry metadata, not interpreted
fields. Table helpers return submitted-source interpretations because their
callers need them. Raw `read` returns detached bytes; mutable byte arrays are
not recursively frozen JSON snapshots. `files.read` reports `NotFound`; typed
`get` recovers that case as successful absence. This difference follows lookup
intent.

Table and KV `update` assign against an internal current-source read. Captured
replace, move, rename, remove, and delete use the caller's observed hash.
Computing a toggle from stale displayed data and passing it to `update` can
supersede a newer same-field value before its read. An editor needing
observation protection prepares captured source and replaces against its
capture. Neither policy retries automatically. ADR-0464 records this
distinction. Structured inputs accept recursively readonly values, including
those taken from a snapshot.

An `Unconfirmed` operation may have published. Retain its requested intent for
review; do not automatically replay it. A subsequent read proves current state,
not historical arrival or non-arrival of the earlier attempt. Internally
prepared updates do not expose exact attempted source/hash in that error and
promise no exact-attempt reconciliation. Adding recovery evidence would be a
separate caller-driven decision, not a status journal implied by this API. A
creator that needs to locate an uncertain generated row supplies an explicit
stem.

The folder exposes individual operations under ADR-0482, without a batch
collector or generic partial receipt. Git methods remain separate from file-save
receipts. File-change notifications are invalidation hints, not proof of complete
external observation. An editor subscribes for its own lifetime; the application
chooses retention, shared controls and autosave timing. Invalid or unsupported
source remains accessible through a separate raw repair workflow.

## Consequences

- Applications and file tools address the same source without importing edits
  into a second current document store.
- Table names cannot collide with resource namespaces. A product may open
  several folders and pass only the views a workflow needs.
- Media files need no separate folder-level blob identity or ownership registry.
  Application fields and Markdown links can address them directly.
- External edits can leave stale links. The folder
  preserves those files; supported app operations enforce their own admission
  checks and report each file operation separately.
- One shared status owner removes per-consumer scan coordination and stale
  response guards. Cached status can be unknown or stale; subscription is not
  proof that every external edit has been observed.

## Considered alternatives

- Put each table directly on the handle: a table named `files` or `close` would
  collide with folder capabilities.
- Require `.md` in table lookup: repeats a fixed format fact at every caller.
- Accept stems and paths interchangeably: introduces normalization and two
  spellings for one lookup.
- Restore one aggregate App handle: couples independent product resources to
  opening a data folder.
- Give every row an owned asset directory: imposes lifecycle coupling on media
  that may be shared through ordinary links.
- Expose only three status flags. They cannot distinguish unknown observations,
  stale checks, concurrent newer edits, and the commit a push actually attempted.
- Poll Git status every few seconds. Full discovery can be expensive and adds
  repeated work when nothing requested a fresh observation.
- Give each UI consumer a refresh cache. It duplicates scan coordination and
  makes stale-response handling every caller's responsibility.

## Implementation

The [folder package](../../packages/folder/README.md) documents the exported
surface and openers. [Contract exports](../../packages/folder/src/contract.ts),
[table views](../../packages/folder/src/table.ts), and
[KV views](../../packages/folder/src/kv.ts) expose the same API across browser,
Bun, and Tauri storage. Application consumers use the flat snapshot shape.
