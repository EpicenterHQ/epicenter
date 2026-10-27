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
  retry applies once. Setting a field edits that one frontmatter key in place,
  keeping the file's other text; the write the server accepts last wins. A body
  patch carries its base text and merges by character. Create, move and delete
  complete the set; a delete that had not seen an edit loses to it.
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
  changes made since that base, if frontmatter does not parse, or if a note
  exceeds 1 MB stored. `epicenter pull` asks the server to commit first.
- **Schemas.** The app brings its own schema, published with its release;
  `epicenter check --schema <url>` validates a clone. The server reads none.
- **The server object.** Its SQLite holds each note's text and sequence, the
  mutation log since the last commit, and the move log. Each commit records the
  server sequence it includes; `main` moves only by compare-and-swap, and the
  log is trimmed only up to what Git holds.
- **Devices.** Notes live in memory, or in SQLite in the browser's storage at
  larger sizes; pending mutations are stored durably. Lists are async, live
  queries; the note being edited is read and written synchronously.
  Per-device settings stay in IndexedDB. Without a server, an app works fully,
  with no history.

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
Codex and Claude reviewers agreed on its class. Before acceptance: tests for
the character merge and the conflict-marker lifecycle; a deployed,
fault-injected spike against a non-production namespace that kills the server
object around each SQLite commit, Git update and reply, and retries the same
mutation and push; and device memory measured on a phone.
