# 0692. People edit a live document and agents merge through Git

- **Status:** Proposed
- **Date:** 2026-10-27
- **Would supersede:** [ADR-0690](0690-merges-happen-only-where-history-records-the-common-ancestor.md) entirely; [ADR-0684](0684-browser-folders-submit-frozen-file-changes-instead-of-running-git.md) and [ADR-0685](0685-hosted-git-records-browser-publication-receipts-in-a-protected-ref.md), whose browser submission path this replaces; [ADR-0650](0650-a-browsers-current-folder-is-one-immutable-tree.md), since a browser no longer holds a Git working tree.
- **Would amend:** [ADR-0534](0534-data-folders-are-the-only-data-model.md) at "folders are the only data model": the Git repository remains the only durable record, and people's apps edit a Yjs document checkpointed into it; [ADR-0686](0686-one-https-site-is-one-portable-release-and-one-data-area.md) and [ADR-0687](0687-opening-a-site-url-opens-its-derived-folder.md) at the derived desktop folder, which is retired; [ADR-0689](0689-an-edit-shows-what-you-typed-the-queue-carries-it-the-folder-shows-what-landed.md) at the desktop live folder; [ADR-0622](0622-a-losing-edit-stays-a-parent-of-the-merge-commit.md), because a conflicting push is rejected rather than overridden; [ADR-0529](0529-commits-happen-only-on-sync-or-when-a-person-saves-a-version.md) and [ADR-0530](0530-applications-record-a-version-at-natural-moments.md), because the server makes people's commits.
- **Relates:** [ADR-0295](0295-a-database-is-one-yjs-document-and-a-row-holds-its-rich-content.md), whose single document this restores as working state rather than as the authority; [ADR-0294](0294-a-database-is-sized-against-a-measured-device-budget-not-an-assumed-ceiling.md) for device memory; [ADR-0620](0620-history-in-a-repository-only-grows.md), which `main` keeps; [ADR-0621](0621-epicenters-library-writes-only-text-to-a-repository-in-v1.md), unchanged: audio stays outside the repository.
- **Evidence:** [browser storage shape](../../packages/folder/evidence/storage-shape-benchmark/RESULTS.md) and [Whispering storage benchmark](../../packages/folder/evidence/whispering-storage-benchmark/results.json).
- **Unbuilt:** all of it. The deciding claims are tested by a throwaway prototype first (see Verification).

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
app must work fully offline without one.

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
between devices and checkpoints changed files into `main` as Markdown commits,
so history is Git. Each document is seeded from a commit and named by that
commit's hash and the seed version, so every device builds the same document
without downloading it. When a repository has no connections and nothing left
to commit, the server deletes its Yjs state after a short wait. The next client
to connect seeds the new document from that commit, carrying over any edits it
made while away. At rest, the server holds only Git.

**Agents' world.** Agents, and people who prefer files, work in Git clones
through `epicenter` clone, pull and push. A push to `main` is accepted only if
it merges cleanly with the live document, which then receives the change like
a collaborator's typing. Otherwise the push is rejected, and the agent pulls
and resolves the conflict. Conflicts belong to whoever works in Git, never to a
person in an app. The repository can be mirrored to GitHub or GitLab, but
pushes go through Epicenter.

**Reading.** Queries read the in-memory document. Full-text search, when a
corpus needs it, is a contentless SQLite index in the browser's storage.

### Mechanism

**The document.** One `Y.Doc` per repository. Each file is an entry keyed by
path: frontmatter fields as attributes (last write per key wins) and the body
as text. Its identity is `<repository>/<commit oid>/<seed version>`. Seeding
inserts the commit's files in path order under a client id derived from that
identity, so seeding is a pure function of the commit and the seed version, and
two devices that seed independently produce byte-identical documents that
merge without duplicating text. A device edits under its own client id. The
seed version names the codec and layout; clients on different seed versions
never share a document, and an outdated client is told to update.

**The server object.** One Durable Object per repository holds the open
WebSockets, the live document (a compacted state plus recent updates, under a
fixed key), and the lock on `main`. It checkpoints by serializing changed
entries to Markdown and committing them. It knows quiet from its own
connections: when the last socket closes it commits what is left and sets an
alarm; a new socket cancels it; when the alarm fires with no connections, the
epoch becomes the latest commit and the Yjs state is deleted. No list of
devices is kept, and nothing is stored per epoch, so nothing is orphaned.

**Changing epochs.** On connect, the handshake names the server's epoch. A
client on that epoch syncs normally. A client on an older epoch fetches the
files whose content differs from its last-synced text, seeds the new document
locally, and carries over its pending edits as a three-way merge whose base is
its text as of its last sync. A client with nothing pending carries nothing;
both are the same algorithm. A client switches only after sync completes, so
its text equals the commit's; this is enforced by the protocol, not checked
afterwards.

**A push.** The server object locks `main`, checkpoints the live document as
commit P, and three-way merges the pushed commit A with P, using A's parent as
the base. A clean merge advances `main` and applies the difference from P into
the live document; people typing meanwhile merge with it through Yjs. A
conflict rejects the push as non-fast-forward.

**Without a server.** The document persists in IndexedDB; nothing is
committed until a server sees it.

## Consequences

People get live editing across devices, offline use, and no conflict UI.
Agents get ordinary Git: clone, branch, commit, push, and resolve. Epicenter
never designs a conflict policy, a merge notice, or a recovery screen; the only
merges it writes are the clean-merge check on push and the offline carry-over,
both against a recorded base.

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
- **`~/Epicenter` is no longer live.** A person editing in Vim or Obsidian
  works in a clone, and their edit reaches other devices only when pushed.
- **Memory.** A full replica costs roughly 1.7 times its text in memory
  (about 250 MiB at 50,000 rows); a snapshot of parsed rows would cost about
  144 MiB. The simpler model was chosen over the saving.
- **Prose merges by character.** Two people rewriting one paragraph at once can
  leave a stray fragment. Agents, whose rewrites are larger, merge through Git
  instead.
- **GitHub or GitLab cannot be the primary remote**, because they cannot run the
  push check. They can be mirrors.

Still undecided: how often the server checkpoints while people type; the
length of the quiet wait; whether a clean merge is by line or by field and line
as `packages/folder/src/shared/merge.ts` merges now; and how schema migrations
change the seed version.

## Considered alternatives

- **A snapshot of the last commit plus Yjs only for files being edited.** Less
  memory and a faster open (0.065 s at 50,000 rows), but it adds a snapshot
  format, a rule that a live document wins over the snapshot, a rule for
  dropping documents, and per-epoch seeding for every edited file. An
  offline-only person would hold everything in Yjs anyway, so the app would
  have two modes.
- **Switching documents at every checkpoint.** Someone is usually typing during
  a checkpoint, so every in-flight edit would need carrying over, for every
  active user, all day. Switching only when quiet keeps that path rare.
- **Keeping the Yjs state permanently on the server.** Simpler, but storage then
  scales with every repository ever opened rather than with active ones.
- **Local files as the authority on desktop (ADR-0690).** Every file edit outside
  the app would need importing into the live document, and the desktop
  folder and the document would race on disk.
- **CRDT merging for agents too.** An agent's paragraph rewrite would interleave
  with people's typing; a Git conflict keeps both intents for someone able to
  resolve them.
- **GitHub or GitLab as the primary remote.** Pushes would bypass the live
  document, and Epicenter would have to resolve the resulting conflicts itself.

## Verification

A throwaway prototype tests the claims this record depends on, before any
production change:

1. Seeding from one commit produces byte-identical documents in Chromium,
   WebKit and Bun, and two seeded copies merge edits without duplicating text.
2. The quiet switch loses nothing, and both clients end on identical documents.
3. An offline carry-over keeps the offline device's edits without undoing
   edits it never saw.
4. A push merges into a document while someone types, and an overlapping push
   is rejected.
5. Opening and seeding are acceptable in WebKit at 5,000 and 50,000 rows.

If claim 1 fails, every quiet switch costs a full document download. If claim
3 fails, offline edits need a different path. Claims 2, 4 and 5 adjust the
design rather than overturn it. Real Durable Object behavior, networks, phone
hardware and cost need a deployed spike afterwards.
