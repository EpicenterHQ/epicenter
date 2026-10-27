# 0692. People and agents write one Git repository through ordered mutations

- **Status:** Proposed
- **Date:** 2026-10-27
- **Would supersede:** [ADR-0690](0690-merges-happen-only-where-history-records-the-common-ancestor.md); [ADR-0684](0684-browser-folders-submit-frozen-file-changes-instead-of-running-git.md), [ADR-0685](0685-hosted-git-records-browser-publication-receipts-in-a-protected-ref.md) and [ADR-0650](0650-a-browsers-current-folder-is-one-immutable-tree.md), since a browser no longer runs Git.
- **Would amend:** [ADR-0534](0534-data-folders-are-the-only-data-model.md), [ADR-0686](0686-one-https-site-is-one-portable-release-and-one-data-area.md), [ADR-0687](0687-opening-a-site-url-opens-its-derived-folder.md), [ADR-0689](0689-an-edit-shows-what-you-typed-the-queue-carries-it-the-folder-shows-what-landed.md) (the live desktop folder is retired); [ADR-0622](0622-a-losing-edit-stays-a-parent-of-the-merge-commit.md) (a conflicting push is refused; people's overlapping text becomes conflict markers); [ADR-0529](0529-commits-happen-only-on-sync-or-when-a-person-saves-a-version.md), [ADR-0530](0530-applications-record-a-version-at-natural-moments.md) (the server makes people's commits); [ADR-0585](0585-a-folders-epicenter-json-is-a-description-for-readers-without-code.md), [ADR-0648](0648-a-folders-saved-views-live-in-its-optional-epicenter-json.md) (apps publish schemas with their releases; saved views are settings); [ADR-0621](0621-epicenters-library-writes-only-text-to-a-repository-in-v1.md) (binary files as Git LFS pointers, later).
- **Relates:** [ADR-0457](0457-a-row-filename-is-its-exact-id-and-a-title-is-a-field.md), whose path addressing this keeps; [ADR-0632](0632-a-lens-belongs-to-its-reader.md): the app brings its own schema; [ADR-0295](0295-a-database-is-one-yjs-document-and-a-row-holds-its-rich-content.md); [ADR-0620](0620-history-in-a-repository-only-grows.md).
- **Evidence:** [storage shape benchmark](../../packages/folder/evidence/storage-shape-benchmark/RESULTS.md); [prototype v1](../../packages/folder/evidence/two-worlds-prototype/RESULTS.md) and [prototype v2](../../packages/folder/evidence/two-worlds-prototype-v2/RESULTS.md), which tested an earlier per-note Yjs variant.
- **Unbuilt:** all of it; see Verification.

## Context

ADR-0690 kept files as the authority on every device: a desktop folder written
through a checked queue, a browser Git working tree, and a merge at sync. It
could not show edits on other devices promptly, it needed conflict UI for
people who never asked for it, and its browser engine opened 50,000 rows in
1.93 s. The benchmarks showed that speed comes from storing parsed data in one
record (0.065 s at 50,000 rows), not from a CRDT. The owner set the product
rules: the remote is a real Git repository agents can clone; teams of people
and agents collaborate on it; edits appear on other devices within a second or
two; people resolve nothing; agents repair what merges badly; apps work offline;
schemas are an app's lens, never enforced by the server.

## Decision

**Git is the record, and one server object per repository orders every
write.** People, apps and agents send writes against a known base: this file,
from this version, now reads like this. The server merges each one into the
current text, broadcasts the result, and commits changed files to `main` once
they are a minute old or when asked. Devices keep the files' text and their
own unsent edits, so apps work offline. Clones read Git directly and may lag
the server by that minute.

- **Files.** A note is `<top-level folder>/<name>.md`; settings are root
  `kv.json`; any other path is kept in Git, merged there as a whole file, and
  never sent to devices. Identity is the path, and a move log lets a write aimed
  at a moved note find it. A device may be offline for up to a week; after that
  the server answers `expired`, the device resyncs, and a write applies only if
  its file is unchanged since its base, otherwise it is saved as an offline
  copy. An app that needs a permanent id declares one in its own schema.
- **Operations.** `write(path, base, text)` covers creating, editing and (with
  no text) deleting; `move(from, to)` carries identity; `append(path, text)`
  adds at the end with no base and never conflicts, for conversations, logs and
  journals. Each carries its device's id and a per-device number, so a retry
  returns the same outcome; its base is the server sequence and content hash
  it started from, and a device keeps its base text until the write is
  acknowledged, sending it when the server answers `need-base`. The server
  stamps each operation with the signed-in user, for permissions, history and
  `Co-authored-by` lines. A reply streamed by an assistant is relayed live
  without being stored, then written as one append.
- **The Epicenter merge.** One pure function, used by the server, by devices
  replaying unsent edits, and by the CLI, merges a write against its base:
  frontmatter and `kv.json` by key, where on a clash the current value wins and
  the other is recorded in the outcome; the body by line, where changes on
  neighboring lines do not conflict, then by word within overlapping lines, so
  letters never blend; two insertions at the same point are both kept, in server
  order; two creates at one path become one file, frontmatter merged by key and
  both bodies kept. For people, a delete loses to an edit it had not seen.
- **Overlaps.** What still overlaps is decided by who wrote: for people, Git
  conflict markers with a base section, in server order, labeled with who, when
  and the sequence; editors such as VS Code show accept and compare actions for
  them, and the app renders each block as a card. The server keeps each block's
  identity, never nests blocks, and removes markers only from a block it created
  once one side is gone. For agents, a refusal naming the file and the overlap.
- **Agents.** `epicenter` commands send the same operations. A `git push` is not
  replayed: its net change since its merge base becomes one batch of writes and
  moves, applied all or nothing, with the pushed commit as a parent of the
  result. It is refused, with the file and reason, if it overlaps changes since
  that base, if frontmatter does not parse, or if a note exceeds 1 MB stored; a
  refusal commits the overlay first, so the agent's next pull is current.
  `epicenter pull` asks the server to commit first.
- **Schemas.** The app brings its own schema, published with its release;
  `epicenter check --schema <url>` validates a clone. The server reads none.
- **The server object.** It holds only an overlay: files changed since the last
  commit, the operations since then, the last number applied per device, and
  the week's moves. Each commit records the server sequence it includes; `main`
  moves only by compare-and-swap, and the overlay is cleared only up to what
  Git holds. At rest it holds almost nothing.
- **Reading.** Devices read committed files without the server object: the head
  commit and its sequence, a diff between two commits, and files by content
  hash in batches. They ask the object only for changes after that sequence, or
  are told to resync from the head.
- **Devices.** Each repository is one SQLite file per device: in the browser's
  storage (OPFS) through a worker owned by one leader tab, natively on desktop,
  and through Bun in the CLI, behind one driver interface and one shared engine.
  Three engine tables, named with a `/` so no folder can collide with them:
  `"epicenter/files"` holds each synced file's folder, name, text, sequence and,
  while edits are unsent, the acknowledged text they started from; its path,
  body, parsed fields and Git hash are generated columns, so only text is ever
  written. `"epicenter/log"` orders moves and appends; `"epicenter/local"` holds
  sync state and this device's own settings. Each app's lens is a set of
  read-only views and indexes over these, recreated on every start; apps query
  them in plain SQL. Writes go only through the API. Any change re-runs live
  queries, whose results are compared before re-rendering; the file being edited
  is held open and read synchronously. Without a server, an app works fully,
  with no history.

## Consequences

Devices lose Git, the browser working tree, the write queue, checked writes
and the close guard, and the design uses no CRDT. Files keep the formatting
their writers gave them; only the edited span changes. People never resolve a
conflict in the app; overlapping text waits in a visible card, and agents can
find and repair it with ordinary tools. The cost is concentrated in the server
object and in a small protocol of our own, shaped like the push and pull of
sync engines such as Replicache. Two people typing in the same words at the same
moment produce a conflict block; a live co-editing session can be
added later if teams need it, replacing only body merging for that note.

Undecided: whether each write is committed to Git before it is acknowledged,
which would remove the overlay if hosted Git keeps up; when LFS lands.

## Verification

Prototypes v1 and v2 tested an earlier per-note Yjs variant; they establish
open times and push-merge behavior, not this design. Independent reviews by
Codex and Claude reviewers agreed on its class. A local spike of the read path
and the overlay found first open from content-addressed notes under 2 s for
5,000 notes at 150 ms latency, reconnect by tree comparison moving a few MB
rather than the whole repository, and the overlay surviving retries, the
resync race and crashes at three points; it also found that writing 50,000
records to IndexedDB took 17 s in Chromium, one reason the device store is
SQLite. Before acceptance: SQLite in OPFS at 5,000 and 50,000 notes in Chromium
and WebKit, with the tab-leader pattern; tests for the character merge and the
conflict-marker lifecycle; a deployed,
fault-injected spike against a non-production namespace that kills the server
object around each SQLite commit, Git update and reply, and retries the same
mutation and push; and device memory measured on a phone.
