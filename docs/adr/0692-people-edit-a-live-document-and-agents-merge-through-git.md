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
write.** People, apps and agents send batches of writes against a known base:
this file, from this version, now reads like this. The server merges each one into the
current text, broadcasts the result, and commits changed files to `main` once
they are a minute old or when asked. Devices keep the files' text and their
own unsent edits, so apps work offline. Clones read Git directly and may lag
the server by that minute.

- **Files.** The repository's data is its Markdown files and Git LFS pointers.
  An app selects files with named path templates such as
  `projects/{project}/tasks/{stem}.md` or `settings.md`: each segment is a
  literal or one parameter with an optional suffix, a parameter never spans a
  `/`, a template without parameters names one file, and an app whose
  templates could claim the same file is refused when it is defined. Parameters
  become typed columns, and apps never write a path string; every call passes
  every segment, including the stem, which a template never generates (apps may
  use plain helpers such as `slug` or `timestamp`). A Markdown file no
  template names (a README, say) is synced and never validated. Binary files
  are always LFS objects in R2, declared by blob templates that also write the
  repository's `.gitattributes`; a push carrying a binary outside LFS is
  refused. Other text files stay in Git and are not downloaded to app devices.
  Identity is the path; the server keeps a week of each path's history
  (creates, moves, deletes), so an edit follows a move and never lands on a
  different note recreated at the same path. A device may be offline for up to
  a week; past that the server answers `expired`, and an edit applies only if
  its file is unchanged since its base, otherwise it is kept as an offline copy.
- **Operations.** Every request is one batch, `{ device, n, changes }`, applied
  all or nothing, with one outcome per change; a `git push` is the same batch.
  A change is `write(path, base, text)` (create, edit, or, with no text,
  delete), `move(from, to)`, which is refused if the destination is taken, or
  `append(path, text)`, which needs no base and can still be stale after a
  delete or an untraceable move. A base is the device's repository position
  and the file's hash; the device keeps the base text and sends it when the
  server answers `need-base`. Setting a value, for example
  `repo.settings.set('theme', 'dark')`, is a write that changes one frontmatter
  field. A batch's outcome is `applied`, `need-base`, `expired` or, for agents,
  `refused`; within `applied`, each file reports its overlaps, dropped values,
  an edit kept over a delete, and its text when that differs from what was
  sent. The per-device number makes a retry return its recorded outcome within
  the window; the server stamps each batch with the signed-in user, for
  permissions, history and `Co-authored-by` lines. A blob is uploaded to R2
  first and its pointer written second, so a pointer never names missing
  bytes. A reply streamed by an assistant is relayed live without being stored,
  then written as one append.
- **The Epicenter merge.** One pure function, used by the server, by devices
  replaying unsent edits, and by the CLI, merges a write against its base:
  frontmatter by key, where on a clash the current value wins and the other is
  recorded in the outcome; the body by line, where changes on neighboring lines
  do not conflict, then by word within overlapping lines, so letters never
  blend; two insertions at the same point are both kept, in server order; two
  creates at one path become one file, frontmatter merged by key and both
  bodies kept. For people, a delete loses to an edit it had not seen. A
  prototype passes 15,000 random cases for these rules and merges cleanly five
  of six cases where `git merge-file` conflicts.
- **Overlaps.** What still overlaps is decided by who wrote: for people, Git
  conflict markers with a base section, in server order, labeled with who, when
  and the sequence; editors such as VS Code show accept and compare actions for
  them, and the app renders each block as a card. The server keeps each block's
  identity, never nests blocks, and removes markers only from a block it created
  once one side is gone. For agents, a refusal naming the file and the overlap.
- **Agents.** `epicenter` commands send the same batches. A `git push` is not
  replayed: its net change since its merge base becomes one batch, with the
  pushed commit as a parent of the result. It is refused, with the file and
  reason, if it overlaps changes since that base, if frontmatter does not
  parse, if a note exceeds 1 MB stored, or if a binary bypasses LFS; a refusal
  commits the overlay first, so the agent's next pull is current. `epicenter
  pull` asks the server to commit first.
- **Schemas.** The app brings its own schema, published with its release;
  `epicenter check --schema <url>` validates a clone. The server reads none.
- **The server object.** It holds only an overlay: files changed since the last
  commit, the batches since then, the last number applied per device, recent
  outcomes, and the week's path history. Each commit records the server
  sequence it includes; `main` moves only by compare-and-swap, and the overlay
  is cleared only up to what Git holds. At rest it holds almost nothing.
- **Reading.** Devices read committed files without the server object: the head
  commit and its sequence, a diff between two commits, and files by content
  hash in batches. They ask the object only for changes after that sequence, or
  are told to resync from the head. Blob bytes are fetched on demand through
  short-lived URLs and cached by hash.
- **Devices.** Each repository is one SQLite file per device: in the browser's
  storage (OPFS) through a worker owned by one leader tab, natively on desktop,
  and through Bun in the CLI, behind one driver interface and one shared engine.
  Three strict engine tables, named with a `/` so no app view can collide with
  them: `"epicenter/files"` holds each synced file's path, text (an LFS pointer
  for a blob), sequence and the hash the server reported, with parsed fields
  and body generated from the text; `"epicenter/outbox"` holds every unsent
  batch in order, with its bases and the exact text sent; `"epicenter/meta"`
  holds the device's id, its next number, its repository position, the parser
  version and this device's own settings. Each app's templates become
  temporary read-only views on the leader's connection, with saved indexes and
  full-text search on the files table itself; apps query them in plain SQL and
  write only through the API. Any change re-runs live queries, whose results
  are compared before re-rendering; the file being edited is held open and read
  synchronously. Without a server, an app works fully, with no history.

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
