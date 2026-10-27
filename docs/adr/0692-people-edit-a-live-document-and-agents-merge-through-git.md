# 0692. People edit a live document and agents merge through Git

- **Status:** Proposed
- **Date:** 2026-10-27
- **Would supersede:** [ADR-0690](0690-merges-happen-only-where-history-records-the-common-ancestor.md) entirely; [ADR-0684](0684-browser-folders-submit-frozen-file-changes-instead-of-running-git.md) and [ADR-0685](0685-hosted-git-records-browser-publication-receipts-in-a-protected-ref.md), whose browser submission path this replaces; [ADR-0650](0650-a-browsers-current-folder-is-one-immutable-tree.md), since a browser no longer holds a Git working tree.
- **Would amend:** [ADR-0534](0534-data-folders-are-the-only-data-model.md) at "folders are the only data model": the Git repository remains the durable record, and people's apps edit a Yjs document checkpointed into it; [ADR-0686](0686-one-https-site-is-one-portable-release-and-one-data-area.md) and [ADR-0687](0687-opening-a-site-url-opens-its-derived-folder.md) at the derived desktop folder, which is retired; [ADR-0689](0689-an-edit-shows-what-you-typed-the-queue-carries-it-the-folder-shows-what-landed.md) at the desktop live folder; [ADR-0622](0622-a-losing-edit-stays-a-parent-of-the-merge-commit.md), because a conflicting push is rejected rather than overridden; [ADR-0529](0529-commits-happen-only-on-sync-or-when-a-person-saves-a-version.md) and [ADR-0530](0530-applications-record-a-version-at-natural-moments.md), because the server makes people's commits; [ADR-0621](0621-epicenters-library-writes-only-text-to-a-repository-in-v1.md), because binary files enter the repository as Git LFS pointers.
- **Relates:** [ADR-0295](0295-a-database-is-one-yjs-document-and-a-row-holds-its-rich-content.md), whose single document this restores as working state checkpointed into Git; [ADR-0294](0294-a-database-is-sized-against-a-measured-device-budget-not-an-assumed-ceiling.md) for device memory; [ADR-0620](0620-history-in-a-repository-only-grows.md), which `main` keeps.
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

The owner's answers settled the product questions this record rests on:
letters must appear on other devices as they are typed; people must never see
a conflict; people who work in Git, directly or through an agent, can resolve
one; the desktop folder need not be live; history requires an account, but an
app must work fully offline without one; the server may keep each repository's
document permanently, as one compacted object; binary files use Git LFS.

## Decision

**People and agents work in two worlds that meet in one repository that
Epicenter hosts.**

**People's world.** An app holds the repository's data as one Yjs document, in
full on each device. Reads and writes are synchronous and in memory, every
device works offline, and changes appear on every connected device as they're
typed. People never see a conflict: concurrent edits merge in the document,
and in the rare worst case a sentence keeps a stray fragment. The desktop app
is the same kind of client as the browser. Without a server, an app still
works fully, with no history.

**The server.** For each repository, one server object relays the document
between devices, keeps it as one compacted object, and checkpoints changed
files into `main` as Markdown commits, so history is Git. A device back from
any time offline syncs like any other Yjs peer; offline edits merge exactly as
live ones do.

**Agents' world.** Agents, and people who prefer files, work in Git clones
through `epicenter` clone, pull and push. A push to `main` is accepted only if
it merges cleanly with the live document, which then receives the change like
a collaborator's typing. Otherwise the push is rejected, and the agent pulls
and resolves the conflict. Conflicts belong to whoever works in Git, never to a
person in an app. The repository can be mirrored to GitHub or GitLab, but
pushes go through Epicenter.

**Reading.** An app's document covers the paths the app declares; the
repository may hold more, and every commit keeps those files unchanged. Within
that scope every Markdown file appears: a valid file as fields and a body, and
an invalid one as its raw text with an issue, shown next to the valid ones and
editable as source. Queries read the in-memory document. Full-text search,
when a corpus needs it, is a contentless SQLite index in the browser's
storage.

**Binary files.** Images, recordings and other binary files are Git LFS
objects stored in R2. The repository holds their pointer files, Markdown refers
to them by relative path everywhere, and apps load them on demand from
short-lived URLs.

### Mechanism

**The document.** One `Y.Doc` per repository. Each file in the app's scope is
an entry keyed by path: frontmatter fields as attributes (last write per key
wins) and the body as text. An invalid file is an entry marked raw whose body is
its whole source; when a later parse succeeds, it becomes fields and a body.
An LFS pointer is an entry holding its object id and size. A new device
downloads the compacted document once and then syncs updates.

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
base. A clean merge advances `main` and applies the difference from P into the
document; people typing meanwhile merge with it through Yjs. A conflict rejects
the push as non-fast-forward. Files outside the app's scope merge in Git alone.

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
files: clone, branch, commit, push, and resolve. Epicenter never designs a
conflict policy, a merge notice, or a recovery screen; the only merge it writes
is the clean-merge check on push, against a recorded base.

The deletion prize, once built: the local write queue and checked writes in
`packages/folder/src/folder.ts`, the native stamp, the Tauri plugin's file
read and put commands, the window-close drain, `<OpenFolder>`'s folder
derivation, isomorphic-git and `packages/folder/src/browser/sync.ts`, the
browser submission protocol of ADR-0684 and ADR-0685, ADR-0622's override
trailer, and the planned merge notice. What remains is the data definition:
table schemas, the Markdown codec (used by checkpoints and the push merge),
hosted Git, and the query surface. The `epicenter` CLI becomes clone, pull and
push.

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
- **GitHub or GitLab cannot be the primary remote**, because they cannot run the
  push check. They can be mirrors, LFS objects included.

Still undecided: whether a clean merge is by line, or by field and line as
`packages/folder/src/shared/merge.ts` merges now; how commits name their
authors when several people's edits land in one; and compaction. Compaction is
a later, explicit operation: a candidate is a pass that runs once every known
device has acknowledged the current state, replacing the document with a fresh
one built from the latest commit.

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

Not yet tested: a device syncing after weeks offline against a document others
kept editing, which is ordinary Yjs behavior; real Durable Object behavior,
networks, phone hardware and cost, which need a deployed spike; and the LFS
batch API and short-lived URLs.
