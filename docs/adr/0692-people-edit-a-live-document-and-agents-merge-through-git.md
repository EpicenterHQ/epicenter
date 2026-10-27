# 0692. People edit a live document and agents merge through Git

- **Status:** Proposed
- **Date:** 2026-10-27
- **Would supersede:** [ADR-0690](0690-merges-happen-only-where-history-records-the-common-ancestor.md) entirely; [ADR-0684](0684-browser-folders-submit-frozen-file-changes-instead-of-running-git.md) and [ADR-0685](0685-hosted-git-records-browser-publication-receipts-in-a-protected-ref.md), whose browser submission path this replaces; [ADR-0650](0650-a-browsers-current-folder-is-one-immutable-tree.md), since a browser no longer holds a Git working tree.
- **Would amend:** [ADR-0534](0534-data-folders-are-the-only-data-model.md) at "folders are the only data model": the Git repository remains the durable record, and people's apps edit a Yjs document checkpointed into it; [ADR-0686](0686-one-https-site-is-one-portable-release-and-one-data-area.md) and [ADR-0687](0687-opening-a-site-url-opens-its-derived-folder.md) at the derived desktop folder, which is retired; [ADR-0689](0689-an-edit-shows-what-you-typed-the-queue-carries-it-the-folder-shows-what-landed.md) at the desktop live folder; [ADR-0622](0622-a-losing-edit-stays-a-parent-of-the-merge-commit.md), because a conflicting push is rejected rather than overridden; [ADR-0529](0529-commits-happen-only-on-sync-or-when-a-person-saves-a-version.md) and [ADR-0530](0530-applications-record-a-version-at-natural-moments.md), because the server makes people's commits; [ADR-0621](0621-epicenters-library-writes-only-text-to-a-repository-in-v1.md), because binary files enter the repository as Git LFS pointers; [ADR-0585](0585-a-folders-epicenter-json-is-a-description-for-readers-without-code.md) and [ADR-0648](0648-a-folders-saved-views-live-in-its-optional-epicenter-json.md), because an app publishes its schema with its release rather than in the repository, and saved views are settings in `kv.json`.
- **Relates:** [ADR-0632](0632-a-lens-belongs-to-its-reader.md), whose principle this applies to repositories: the app brings its own schema; [ADR-0295](0295-a-database-is-one-yjs-document-and-a-row-holds-its-rich-content.md), whose single document this restores as working state checkpointed into Git; [ADR-0503](0503-file-authoritative-workflows-preserve-information-and-tolerate-repairable-states.md), whose tolerance of repairable files this keeps; [ADR-0294](0294-a-database-is-sized-against-a-measured-device-budget-not-an-assumed-ceiling.md) for device memory; [ADR-0620](0620-history-in-a-repository-only-grows.md), which `main` keeps.
- **Evidence:** [browser storage shape](../../packages/folder/evidence/storage-shape-benchmark/RESULTS.md), [Whispering storage benchmark](../../packages/folder/evidence/whispering-storage-benchmark/results.json), and the [two worlds prototype](../../packages/folder/evidence/two-worlds-prototype/RESULTS.md).
- **Unbuilt:** all of it. A throwaway prototype tested the push merge and open times (see Verification); a deployed spike has not run.

## Context

Three designs preceded this one. ADR-0295 kept a database as one Yjs document
and projected Markdown from it; agents write files, so every file edit needed a
custom import back into the document, and ADR-0534 replaced the store with
folders. ADR-0690 then kept files as the authority everywhere: a desktop folder
written through one checked queue, a browser Git working tree, and a three-way
merge per file at sync that lets the last edit win and keeps the loser as a
merge parent.

That design left three things unsolved. People typing on two devices would not
see each other's changes until sync, and live collaboration was only an
unbuilt "session over the body". Sync conflicts needed a notice and recovery UI
for people who never asked to resolve conflicts. And the browser engine was
slow at scale: with Whispering's five tables at 10,000 rows each (50,000 rows,
about 147 MB of text) in Chromium, opening took 1.93 s, and one saved edit cost
58 ms plus a 500 ms relist.

The benchmarks also showed where the time goes. Reading the same data as one
IndexedDB record takes about 33 ms; the cost is one request per Git blob and
parsing Markdown (about 31 µs per row). One Yjs document opened in 0.33 to
0.52 s and held about 250 MiB; a durable edit cost 0.7 ms. Tombstones were
negligible: 2,000 single-character edits left 8 KB over a fresh rebuild.

Settings were once a root `kv.json` (ADR-0267, ADR-0551) and were removed on
2026-10-16 in commit `6839db464b`, because they were a second data model beside
tables, with their own reader, write queue, merge and errors; settings became
rows of a `settings` table. In a live document, settings are one more map
resolved per key, the rule fields already follow, so that reason no longer
holds.

The owner's answers settled the product questions this record rests on:
letters must appear on other devices as they are typed; people must never see
a conflict; people who work in Git, directly or through an agent, can resolve
one; the desktop folder need not be live; history requires an account, but an
app must work fully offline without one; the server may keep each repository's
document permanently, as one compacted object; binary files use Git LFS; rows
have stable ids; the app brings its own schema, and nothing enforces one in
the repository; tables are top-level folders.

## Decision

**Epicenter keeps your whole life's writing in one place, as plain text you
own.** People and agents work in two worlds that meet in one Git repository
that Epicenter hosts.

**The repository.** Each top-level folder the app declares is a table of
Markdown rows, and the root `kv.json` holds the app's settings. Binary files
are Git LFS objects in R2, referred to by relative path. Every other path is
kept and not loaded. Every file Epicenter writes is formatted deterministically
from its content and the app's schema. The app brings its own schema, published
with its release; nothing in the repository enforces a shape, and
`epicenter check` validates a clone against an app's published schema. Rows
that don't match appear in the app as issues. Migrations, and whether an
outdated app may keep writing, are the app developer's choice; a migration
must be idempotent.

**People's world.** An app holds the repository's data as one Yjs document, in
full on each device: rows keyed by stable id with their path as an attribute,
fields and settings resolved per key, bodies as text. Reads and writes are
synchronous and in memory, every device works offline, changes appear on every
connected device as they're typed, and nobody sees a conflict. Invalid files
appear next to valid ones as source with their issues. Settings for one device
stay in that device's storage and never enter the repository. Without a
server, an app still works fully, with no history.

**The server.** For each repository, one server object relays the document,
keeps it as one compacted object, and checkpoints changed files into `main`
after an idle period, at a maximum interval, before each push, and when the
last device leaves; the periods are a setting at the repository, organization
or account level. The server reads no schema. A device back from any time
offline syncs like any other Yjs peer.

**Agents' world.** Agents work in Git clones with `epicenter` clone, pull and
push. A push to `main` is accepted only if it merges cleanly, by field and by
line, with the live document; otherwise the agent pulls and resolves. The
repository can be mirrored to GitHub or GitLab, but pushes go through
Epicenter.

### Mechanism

**The document.** One `Y.Doc` per repository. A row is an entry keyed by its
stable id, with its path, its frontmatter fields (last write per key wins) and
its body as text. Settings are one map in the same document, keyed by setting.
An invalid file is an entry marked raw whose body is its whole source; when a
later parse succeeds, it becomes fields and a body. An LFS pointer is an entry
holding its object id and size. A new device downloads the compacted document
once and then syncs updates.

**Stable ids.** A row's id is the first frontmatter key, `id`, so a rename is
one change to the entry's path and typing on another device survives it. Git
guarantees unique paths, not unique ids, so a file's id is decided in order:
the `id` in its frontmatter if no other file has it; otherwise the id of the
entry already at its path, which covers a deleted `id` line and invalid
frontmatter; otherwise a new id, which the next checkpoint writes into the
file. If two entries claim one path, the newer one is written with a suffix.

**Formatting.** Frontmatter keys are written as `id`, then the schema's
declared order, then keys the schema doesn't name, sorted. Unknown keys are
kept, never dropped. `kv.json` follows the same order with a fixed indent.
Bodies end with one line feed.

**The schema.** An app hosts its JSON Schema at a public URL with each release.
`epicenter check <dir> --schema <url>` validates a clone against it, whether
the URL is a production site or `localhost` during development; the CLI caches
the schema it fetched. The repository record in Postgres names the app that
opens the repository. Anyone may also keep an `epicenter.json` or other notes
for their own agents; Epicenter treats it as an ordinary file. A migration is
the app's own code: a function of a row's current state, so two up-to-date
apps running it at once converge in the document. An agent may migrate rows in
a clone instead.

**Device storage.** Settings for one device live in IndexedDB through
`@epicenter/device`, on every platform; the desktop app is a webview client
like the browser. A native store would earn its place only if something
outside the webview needed those settings.

**The server object.** One Durable Object per repository holds the open
WebSockets, the document (one compacted state plus recent updates, under a
fixed key and overwritten in place), and the lock on `main`. Storage is about
the text's size per repository, and nothing accumulates per version.

**When commits happen.** The server object commits the files that changed when
the document has had no updates for the idle period, at most once per maximum
period during continuous typing, before every push merge, and when the last
device disconnects. A commit is a snapshot at an instant; typing continues
through it. The idle and maximum periods (2 and 30 minutes by default) are a
setting at the repository, organization or account level, resolved in that
order, and stored in Postgres beside the repository record that
`apps/api/worker/git-repositories.ts` reads. The server object reads the
effective setting when it starts and when the setting changes.

**A push.** The server object locks `main`, checkpoints the document as commit
P, and three-way merges the pushed commit A with P, using A's parent as the
base: frontmatter by field, `kv.json` by key, bodies by line. A clean merge
advances `main` and applies the difference from P into the document; people
typing meanwhile merge with it through Yjs. A conflict rejects the push as
non-fast-forward. Files outside the app's scope merge in Git alone. Whether
the pushed files match any schema plays no part.

**Binary files.** The server implements the Git LFS batch API over R2, so a
clone fetches objects with `git lfs pull`, and the repository's
`.gitattributes` names which paths are LFS. In an app, a renderer resolves a
relative path against its Markdown file's directory, finds the pointer entry in
the document, and asks the server for a short-lived URL for that object id; the
browser loads the object directly from R2. Object ids are content hashes, so a
loaded object can be cached indefinitely and shown offline. An upload goes to
R2 through a presigned URL, then adds a pointer entry to the document; the next
commit writes the pointer file.

**Without a server.** The document persists in IndexedDB; nothing is
committed until a server sees it. Binary files stay on the device until then.

## Consequences

People get live editing across devices, offline use that merges like live
editing, and no conflict UI. Agents get ordinary Git, with LFS for binary
files: clone, branch, commit, push, resolve, and check against an app's
schema. Epicenter never designs a conflict policy, a merge notice, or a
recovery screen; the only merge it writes is the clean-merge check on push,
against a recorded base. The server knows no schema, so apps evolve their
shapes without a server release.

The deletion prize, once built: the local write queue and checked writes in
`packages/folder/src/folder.ts`, the native stamp, the Tauri plugin's file
read and put commands, the window-close drain, `<OpenFolder>`'s folder
derivation, isomorphic-git and `packages/folder/src/browser/sync.ts`, the
browser submission protocol of ADR-0684 and ADR-0685, ADR-0622's override
trailer, the planned merge notice, the `settings` table convention, and the
declaration file an app publishes into a folder. What remains is the data
definition: table and settings schemas, the Markdown codec (used by
checkpoints and the push merge), hosted Git with LFS, and the query surface.
The `epicenter` CLI becomes clone, pull, push and check.

The costs:

- **The server becomes required for live editing and for history.** An
  offline-only person has a working app and no commits. Self-hosting means
  running the same server code.
- **Storage about doubles per repository:** Git's objects plus the compacted
  document, which is about the size of the text.
- **`~/Epicenter` is no longer live.** A person editing in Vim or Obsidian
  works in a clone, and their edit reaches other devices only when pushed.
- **Memory.** A full replica costs roughly 1.7 times its text in memory
  (about 250 MiB at 50,000 rows); a snapshot of parsed rows would cost about
  144 MiB. The simpler model was chosen over the saving.
- **Prose merges by character.** Two people rewriting one paragraph at once,
  live or after time offline, can leave a stray fragment. Agents, whose
  rewrites are larger, merge through Git instead.
- **Keystrokes in flight are not checked.** The push check sees only updates
  the server has received; keystrokes in flight when a push lands merge with
  it through Yjs, by character in the same paragraph.
- **People can see issues an agent caused.** A push that breaks rows is
  accepted, and the rows show as issues until someone fixes them.
- **An outdated app can keep writing old shapes** unless its developer stops
  it; with an idempotent migration, the rows converge once it updates.
- **A clone does not describe itself.** Validating it needs the app's published
  schema, fetched once and cached.
- **Every row carries an `id` field.**
- **GitHub or GitLab cannot be the primary remote**, because they cannot run the
  push check. They can be mirrors, LFS objects included.

Still undecided: how commits name their authors when several people's edits
land in one; one id format for every app or one per app; how nested folders
would work if a vault outgrows one level (a table owning its whole subtree,
with the relative path as the row's location, is the likely shape); and
compaction. Compaction is a later, explicit operation: a candidate is a pass
that runs once every known device has acknowledged the current state,
replacing the document with a fresh one built from the latest commit.

## Considered alternatives

- **Deleting the document when a repository is quiet, and seeding the next one
  from a commit (epochs).** Nothing would stay on the server at rest, but it
  needs deterministic seeding, a seed version, per-file hashes in the
  handshake, a last-synced copy on every device, and a carry-over merge for
  devices returning from offline. That carry-over is a second merge rule:
  where live editing interleaves two rewrites of one paragraph by character,
  the carry-over kept both versions as whole lines. The prototype built and
  tested it; keeping the document removes all of it.
- **A snapshot of the last commit plus Yjs only for files being edited.** Less
  memory and a faster open (0.065 s at 50,000 rows), but it adds a snapshot
  format, a rule that a live document wins over the snapshot, and a rule for
  dropping documents. An offline-only person would hold everything in Yjs
  anyway, so the app would have two modes.
- **An `epicenter.json` the app publishes into the repository, enforced on
  push.** The server would validate every push against it, accept changes to
  it only from the app, and gate outdated clients. That puts schemas in the
  server and keeps a copy of the app's schema in the repository that can drift
  from the app. The app's own lens, published with its release, does the same
  job for agents through `epicenter check`.
- **Keying rows by path, or using the filename as the id.** Keyed by path, a
  rename deletes the entry another device is typing into. Using the filename
  as the id avoids that and needs no `id` field, but filenames become opaque
  and can never change.
- **Settings as rows of a `settings` table.** One file per setting is awkward
  for people and agents, and the reason for it, avoiding a second data model,
  no longer applies.
- **Local files as the authority on desktop (ADR-0690).** Every file edit outside
  the app would need importing into the live document, and the desktop
  folder and the document would race on disk.
- **CRDT merging for agents too.** An agent's paragraph rewrite would interleave
  with people's typing; a Git conflict keeps both intents for someone able to
  resolve them.
- **GitHub or GitLab as the primary remote.** Pushes would bypass the live
  document, and Epicenter would have to resolve the resulting conflicts itself.
- **Binary files in Git, or in R2 referenced by hash.** In Git, every clone and
  mirror grows with every image and recording. Referenced by hash, relative
  paths stop working in clones, and mirrors carry dangling references. LFS
  keeps the repository text and relative paths working everywhere.
- **Commit timing in a file in the repository.** It would travel to mirrors,
  where it means nothing, and any agent could change the server's behavior by
  pushing. It is the host's setting, not the data's.

## Verification

A throwaway prototype in
[`packages/folder/evidence/two-worlds-prototype/`](../../packages/folder/evidence/two-worlds-prototype/RESULTS.md)
uses an in-process stand-in for the server object. Its results that bear on
this decision:

- A push lands as a merge commit while another device's keystrokes are in
  flight, and both survive on every device and in the next commit. An
  overlapping push is rejected with the conflicting path, and lands after the
  agent pulls and merges.
- At 50,000 rows, WebKit opens the document in 345 to 382 ms and Chromium in
  287 to 324 ms; at 5,000 rows, both open in under 60 ms.
- It also built the epoch alternative: byte-identical seeds in Bun, Chromium
  and WebKit, the quiet switch, and the offline carry-over all held, and the
  carry-over's second merge rule is why that alternative was dropped.

The prototype keyed entries by path; stable ids, `kv.json`, field-level push
merges, and LFS are not yet tested. Also untested: a device syncing after
weeks offline against a document others kept editing, which is ordinary Yjs
behavior; and real Durable Object behavior, networks, phone hardware and cost,
which need a deployed spike.
