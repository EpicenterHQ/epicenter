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
write.** People, apps and agents write small mutations against a known base:
set a field, patch body text, create, move, delete. The server applies them to
each note's text in order, broadcasts the change, and commits changed notes to
`main` once they are a minute old or when asked. Devices keep the notes' text
and their own pending mutations, so apps work offline. Clones read Git
directly and may lag the server by that minute.

- **Notes are text.** A note is `<top-level folder>/<name>.md`; settings are
  root `kv.json`; any other path is kept and never loaded. The server stores
  each note's text keyed by path, and a move log keeps mutations aimed at a
  note that has since moved. An app that needs a permanent id declares an `id`
  field in its own schema.
- **Mutations.** Each carries its device's id and a per-device number, so a
  retry applies once, and the server sequence of the value it saw. **A write
  replaces only what it saw:** setting a field or setting edits that one key in
  place, keeping the file's other text, and is not applied if the key changed
  since; a delete that had not seen an edit loses to it. A body patch carries
  its base text and merges by character. Append adds text at the end in server
  order and never conflicts, for conversations, logs and journals. Create and
  move complete the set; a create at a path already taken is saved under a
  numbered copy (`ideas (2).md`) and reported. A reply streamed by an assistant
  is relayed live without being stored, then written as one append.
- **Conflicts.** When two body edits change the same characters, the note gets
  Git conflict markers with a base section, in the order the server accepted
  the edits, labeled with who, when and the server sequence. Editors such as
  VS Code show accept and compare actions for them; the Epicenter app renders
  each block as a card before rendering Markdown. When only one side of a block
  remains, the server removes its markers on the next write; damaged markers
  are left as written.
- **Agents.** `epicenter set`, `patch`, `create`, `mv` and `rm` send mutations
  that merge like a person's. `git push` is diffed against its actual merge
  base into mutations and refused, with the file and reason, if it overlaps
  changes made since that base (including a path created since), if
  frontmatter does not parse, or if a note exceeds 1 MB stored. `epicenter pull`
  asks the server to commit first.
- **Schemas.** The app brings its own schema, published with its release;
  `epicenter check --schema <url>` validates a clone. The server reads none.
- **The server object.** It holds only an overlay: the notes changed since the
  last commit, their mutations, the last number applied per device, and recent
  moves. Each commit records the server sequence it includes; `main` moves only
  by compare-and-swap, and the overlay is cleared only up to what Git holds. At
  rest it holds almost nothing; Git holds the text.
- **Reading.** Devices read committed notes without the server object: the head
  commit and its sequence, a diff between two commits, and notes by content
  hash in batches. They ask the object only for changes after that sequence, or
  are told to resync from the head.
- **Devices.** Each repository is one SQLite file per device: in the browser's
  storage (OPFS) through a worker, natively on desktop, and through Bun in the
  CLI, behind one driver interface and one shared engine. Engine tables are
  named with a `/` so no folder can collide with them: `"epicenter/files"`
  holds each note's text, its frontmatter parsed once into JSON, and its
  sequence; others hold settings, pending mutations, sync state and settings
  for this device only. Each app's lens is a set of read-only views and indexes
  over them, recreated on every start; apps query them in plain SQL. Writes go
  only through the API as mutations. Any change re-runs live queries, whose
  results are compared before re-rendering; the note being edited is held open
  and read synchronously. Without a server, an app works fully, with no
  history.

## Consequences

Devices lose Git, the browser working tree, the write queue, checked writes
and the close guard, and the design uses no CRDT. Files keep the formatting
their writers gave them; only the edited span changes. People never resolve a
conflict in the app; overlapping text waits in a visible card, and agents can
find and repair it with ordinary tools. The cost is concentrated in the server
object and in a small protocol of our own, shaped like the push and pull of
sync engines such as Replicache. Two people typing in the same sentence at the
same moment can produce a conflict block; a live co-editing session can be
added later if teams need it, replacing only body merging for that note.

Undecided: how commits name their authors; when LFS lands; the exact point at
which a push takes effect relative to mutations, which the spike must fix.

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
