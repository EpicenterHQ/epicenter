# 0692. People edit live notes and agents merge through Git

- **Status:** Proposed
- **Date:** 2026-10-27
- **Would supersede:** [ADR-0690](0690-merges-happen-only-where-history-records-the-common-ancestor.md); [ADR-0684](0684-browser-folders-submit-frozen-file-changes-instead-of-running-git.md), [ADR-0685](0685-hosted-git-records-browser-publication-receipts-in-a-protected-ref.md) and [ADR-0650](0650-a-browsers-current-folder-is-one-immutable-tree.md), since a browser no longer runs Git.
- **Would amend:** [ADR-0534](0534-data-folders-are-the-only-data-model.md), [ADR-0686](0686-one-https-site-is-one-portable-release-and-one-data-area.md), [ADR-0687](0687-opening-a-site-url-opens-its-derived-folder.md), [ADR-0689](0689-an-edit-shows-what-you-typed-the-queue-carries-it-the-folder-shows-what-landed.md) (the live desktop folder is retired); [ADR-0622](0622-a-losing-edit-stays-a-parent-of-the-merge-commit.md) (a conflicting push is refused, not overridden); [ADR-0529](0529-commits-happen-only-on-sync-or-when-a-person-saves-a-version.md), [ADR-0530](0530-applications-record-a-version-at-natural-moments.md) (the server makes people's commits); [ADR-0585](0585-a-folders-epicenter-json-is-a-description-for-readers-without-code.md), [ADR-0648](0648-a-folders-saved-views-live-in-its-optional-epicenter-json.md) (apps publish schemas with their releases; saved views are settings); [ADR-0621](0621-epicenters-library-writes-only-text-to-a-repository-in-v1.md) (binary files as Git LFS pointers).
- **Relates:** [ADR-0632](0632-a-lens-belongs-to-its-reader.md): the app brings its own schema; [ADR-0295](0295-a-database-is-one-yjs-document-and-a-row-holds-its-rich-content.md); [ADR-0620](0620-history-in-a-repository-only-grows.md).
- **Evidence:** [storage shape benchmark](../../packages/folder/evidence/storage-shape-benchmark/RESULTS.md), [prototype v1](../../packages/folder/evidence/two-worlds-prototype/RESULTS.md), [prototype v2](../../packages/folder/evidence/two-worlds-prototype-v2/RESULTS.md).
- **Unbuilt:** all of it; see Verification.

## Context

ADR-0690 kept files as the authority on every device: a desktop folder written
through a checked queue, a browser Git working tree, and a merge at sync. It
could not show letters on another device as they are typed, it needed conflict
UI for people who never asked for it, and its browser engine opened 50,000
rows in 1.93 s. The owner set the product rules this record rests on: live
typing across devices, no conflicts for people, agents in Git clones resolving
their own conflicts, no live desktop folder, history through a server, a fully
working app offline without one.

## Decision

**Each note is a small live document; every device holds all of them, and the
server stores them and loads one at a time. The server relays typing, writes
changed notes to Git every few minutes, and accepts an agent's push only if
every file parses, every note keeps its id, no note exceeds the size limit,
and nothing overlaps recent typing. Otherwise it says exactly why, and the
agent fixes it.**

- **Notes.** A note is a Markdown file in a top-level folder: frontmatter
  fields and a body. Its live form is one Yjs document: fields resolved per
  key, the body as text, and its path as an attribute, keyed by a stable `id`
  that is the file's first frontmatter key. A rename changes the path, so
  typing elsewhere survives it.
- **Settings.** The root `kv.json` is one more live document, resolved per key.
- **The size invariant.** No note exceeds 1 MB of text. A push with a larger
  file is refused; an app stops a note from growing past it and says why. This
  bounds every server operation, keeps each note's stored state under the
  storage value limit without chunking, and bounds editor cost.
- **The server.** One server object per repository relays each update after
  storing it durably, keeps each note's compacted state (the same Yjs history,
  never rebuilt from text), and writes changed notes into `main` as
  deterministic Markdown (`id`, then keys sorted) when typing pauses, at a
  maximum interval, before a push, and when the last device leaves. The
  periods are a repository, organization or account setting in Postgres. It is
  the only writer of `main`. A device back from any time offline syncs like any
  other peer.
- **Agents.** Agents work in Git clones with `epicenter` clone, pull, push and
  check. A push is compared with the server's latest checkpoint and merged by
  note id, field, setting key and body line. It is refused, with the file and
  reason, if a file's Markdown does not parse, a note's id was removed or is
  claimed twice, a file exceeds the size limit, or it overlaps edits people
  made since the agent's base. A push that does not match an app's schema is
  accepted; the app shows those rows as issues.
- **Schemas.** The app brings its own schema, published with its release;
  `epicenter check --schema <url>` validates a clone against it. The server
  reads no schema. Migrations are the app's code and must be idempotent.
- **Everything else.** Paths outside the note layout are kept and never
  loaded. Binary files are Git LFS objects in R2, referenced by relative path.
  Per-device settings stay in the device's IndexedDB. Without a server, an app
  works fully, with no history.

## Consequences

Devices lose Git, the browser working tree, the write queue, checked writes
and the close guard. People never see a conflict; agents see ordinary Git
refusals. The cost is concentrated in the server object: durable updates,
compaction, checkpoints, and the push check. Storage roughly doubles per
repository (Git plus live state). A desktop folder is a clone, not live.
Two people rewriting one sentence at once interleave their words. A note is
the unit of atomic change; a migration applies note by note.

Undecided: whether Git lives in the server object's own storage, which would
write a commit and its notes in one transaction and remove every crash window
between the two stores, or in Cloudflare Artifacts, which needs a recorded
intent and recovery around each update of `main`; how commits name their
authors; and when LFS lands.

## Verification

Prototypes v1 and v2 (in-process, 26 tests) established deterministic
seeding, live merges, stable-id renames, field-level push merges, and open
times (WebKit opens 50,000 rows in 345 to 382 ms). An independent review by two
Codex reviewers and one Claude reviewer agreed on this direction. Before this
record is accepted, a deployed spike against a non-production namespace must
show: no accepted push is ever reverted when the server object dies at any
step; a device returning after long offline merges against compacted state;
server memory stays bounded with many repositories in one isolate; and each
push refusal above fires with a clear message.
