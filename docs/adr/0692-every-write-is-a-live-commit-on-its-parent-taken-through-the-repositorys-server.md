# 0692. Every write is a live commit on its parent, taken through the repository's server

- **Status:** Proposed
- **Date:** 2026-10-29
- **Would supersede:** [ADR-0622](0622-a-losing-edit-stays-a-parent-of-the-merge-commit.md) (the last edit to reach `main` wins each unit, and Epicenter writes no conflict marker): a clash is a conflict block in the note; [ADR-0529](0529-commits-happen-only-on-sync-or-when-a-person-saves-a-version.md) (a commit happens only at sync or when a person saves a version): the server flushes live history into Git on its own schedule.
- **Would amend:** [ADR-0619](0619-every-byte-epicenter-keeps-is-a-git-object-a-working-file-an-access-list-row-or-a-cache.md) at "Repository content has one committed history: Git": live history runs ahead of Git until the next flush; [ADR-0534](0534-data-folders-are-the-only-data-model.md) at the device's copy: a device holds a replica database of the repository's files, not a folder it writes through; [ADR-0621](0621-epicenters-library-writes-only-text-to-a-repository-in-v1.md) at binary files ("Git LFS pointers ... are not designed"): every file that is not a note is a canonical LFS pointer, at any path an app names.
- **Relates:** [ADR-0620](0620-history-in-a-repository-only-grows.md), whose rule `main` keeps; [ADR-0695](0695-one-sync-engine-runs-on-every-device-and-a-folder-on-disk-is-its-watched-projection.md), which runs the replica on every device and decides that typing is safe once it reaches the engine; [ADR-0693](0693-repositories-are-addressed-and-every-page-is-an-owner-a-repository-or-an-app-on-one.md) (what a repository and its address are); [ADR-0696](0696-a-page-writes-a-repository-only-through-its-worker-over-collections-its-app-declares.md) (the app API over the replica); [ADR-0697](0697-all-text-merges-from-everyone.md) (all text merges, from everyone: the one write rule this record runs, and the `git push` limitation); [ADR-0457](0457-a-row-filename-is-its-exact-id-and-a-title-is-a-field.md) (a path is a note's identity); [ADR-0632](0632-a-lens-belongs-to-its-reader.md) (the server reads no schema).
- **Unbuilt:** the hosted server (a Durable Object host, Cloudflare Artifacts as `GitObjects`, R2 for blob bytes behind presigned uploads); a `git push` transport into `receive` (the receiver and its checks are built, no receive-pack endpoint is); accounts and membership (the development server makes anyone the owner their `Authorization: Bearer <name>` names); the GitHub mirror and Action; the `epicenter` commands agents run.

## Context

[ADR-0690](0690-merges-happen-only-where-history-records-the-common-ancestor.md)
kept files as the authority on every device: a browser Git working tree
([ADR-0650](0650-a-browsers-current-folder-is-one-immutable-tree.md),
[ADR-0684](0684-browser-folders-submit-frozen-file-changes-instead-of-running-git.md),
[ADR-0685](0685-hosted-git-records-browser-publication-receipts-in-a-protected-ref.md)),
a desktop folder written through a checked queue
([ADR-0689](0689-an-edit-shows-what-you-typed-the-queue-carries-it-the-folder-shows-what-landed.md)),
and a merge at sync in which the last edit to reach `main` wins each unit
([ADR-0622](0622-a-losing-edit-stays-a-parent-of-the-merge-commit.md)). Edits
did not reach other devices promptly, and that browser engine opened 50,000
rows in 1.93 s. The owner set the product rules: the remote is a real Git
repository agents can clone; people and agents share it; edits appear on
other devices within a second or two; people resolve nothing in a dialog;
agents repair what merges badly; apps work offline; a schema is an app's
lens, never enforced by the server.

The first draft of this record sent batches of per-file writes against a
base, with per-device sequence numbers, `move` and `append` operations, a
week of path history, and stored outcomes. A deciding test showed that a
write conditioned on a file's hash starves a busy note and needs about ten
extra rules, half of them because a hash can neither order writes nor tell
two notes at one path apart. Naming the state a write was made on, as Git
does, removed those rules.

## Decision

**Every write is a live commit on the state it was made on, and the server
for the repository takes it.** A live commit (`LiveCommit`,
`packages/repository/src/core/commit.ts`) is a snapshot of the files it
changes on top of a parent:

```txt
{ id, parent, author: { user, device }, time, files: [{ path, text | null }] }
```

`id` is `commitId`, the Git blob id of the commit's canonical form, so it
hashes the parent and the content, never repeats, and makes a resend
recognizable. `text: null` deletes the file. There is no move and no append:
a rename is a delete of the old path and a write of the new one, saved
in one call. Everything one call saves is one group (`"epicenter/groups"`
on the device), and a group goes in one commit or not at all.
`time` is a label people read in conflict blocks, never an order.

**`main` only moves forward, and every writer's commit meets a `main` that
moved the same way** ([ADR-0697](0697-all-text-merges-from-everyone.md)).
If the parent is `main`, `main` becomes the commit. Otherwise the commit is
merged path by path, a note with `settle` (`core/settle.ts`) and a blob by
compare-and-swap (`settlePointer`), and lands as a merge commit whose
second parent is the writer's commit. A commit carries no mode: who wrote
it changes its label, never how it settles. A one-file HTTP write (`PUT`
with `If-Match`, `If-None-Match: *` to create, `DELETE` with `If-Match`)
is a commit on `main` with that precondition, checked inside the server's
transaction: HTTP's conditional write, the one text write refused
(`file-moved`) because of someone else's write. A one-shot client that
wants merging reads a file (`GET /files/<path>` names the commit it read
as `Epicenter-Commit`) and posts a commit on that parent to
`POST /commits`.

**A blob never merges.** A blob write lands only where the path still holds
the blob in the commit's parent; a create or replace that does not is
refused (`blob-changed`) and held with why, and a delete that does not
leaves the file. Holding a blob holds its group.

**Every conflict is text.** `settle` runs the Epicenter merge (`core/merge.ts`):

- Frontmatter merges by key. When both sides set one key, the current value
  stays in the frontmatter, and the incoming value is written into the body
  as a labelled conflict block.
- The body merges by line, so edits on neighboring lines do not conflict.
  Lines both sides changed merge again by word. What still overlaps is a
  conflict block.
- A delete against an edit it had not seen keeps the edit, and an edit
  brings a deleted note back.
- Two creates at one path, or a stale edit to a path deleted since its base
  (`deletedSince`), keep the note that is there and append the incoming
  text whole as one block.
- One clash is one block, however many writes follow it: an edit of lines
  that a block already offers as a side continues that side
  (`continuedBlock`, `withSide`), and a block identical to one in the note
  is not written again.

A block is the one grammar `core/conflict.ts` writes and reads:

```txt
<<<<<<< current alice/laptop 2026-10-28T14:02:11Z 3f2a1c9
||||||| base 9b8e7d6
=======
>>>>>>> incoming bob/phone 2026-10-28T14:02:12Z 1a2b3c4
```

Each label names the side, its author, its time and the short Git blob id
of the note that side had. A line of the note that would read as a
delimiter is escaped. People resolve a block by editing the text; nothing
waits for a person to choose, and the server never removes a block.

**The server is the repository's only door, and every file it takes passes
the door's rules.** `admit` (`server/server.ts`) checks, in order:

| Check | Refused as |
| --- | --- |
| A session, a member, not a `reader` | `no-session`, `not-member`, `reader` |
| Pushes per member, a bucket of 30 refilled at 10 a second | `rate` |
| `id` is the hash of the commit; `author.user` is the session's user | `bad-id`, `not-author` |
| `time` is an ISO instant at most 5 minutes ahead of the server's clock | `bad-time`, `clock-ahead` |
| At most 4 MB as JSON, 1,000 files, one entry per folded path | `too-large`, `too-many-files`, `path-twice` |
| A path at most 512 bytes | `path-too-long` |
| `admissible(path, text)` (`core/door.ts`), below | `inadmissible`, with the door's reason |
| A pointer's bytes present at its size; a blob write lands only over the blob its writer saw | `blob-missing`, `blob-changed` |

`admissible` is one pure predicate the device, the server and a GitHub
Action share. A note (`.md` in any case) parses, uses LF with no byte order
mark, is at most 1 MB, is never an LFS pointer, and its frontmatter holds at
most `FRONTMATTER_KEYS` (1,000) keys and `FRONTMATTER_VALUES` (10,000)
scalars, nested at most `FRONTMATTER_NESTING` (64) deep. Every text is valid
UTF-8 with no NUL, and every file that is not a note is a canonical LFS
pointer naming at most 2 GiB (`MAX_BLOB_BYTES`). Paths are NFC, hold no `.git` component, are legal on Windows and
macOS, and keep each segment within 255 bytes; Epicenter alone writes
`.gitattributes` (`ATTRIBUTES`: every file through LFS, notes and the file
itself as text), `.lfsconfig`, `.gitmodules` and `.epicenter/`. `lint`
only warns: unresolved or malformed conflict blocks, a path over 260 bytes. Paths equal after
NFC and case folding (`fold`) are one path, and a write goes to the spelling
`main` has. A merge result passes `admissible` too, and two named
exceptions refuse a text writer because of someone else: a merge that would grow
a note past 1 MB (`merge-too-large`), and one that would leave more than
`BLOCK_CAP` (20) conflict blocks in a note (`too-many-blocks`, "this note
has unresolved conflicts; resolve some first"). The server reads no schema.

**A device holds text the shared text cannot take, with its reason, and
nothing else.** The replica (`openReplica`, `client/replica.ts`) keeps four
levels per file: `base` (the text at its position), `sent` (in the commit
awaiting an answer), `committed` (in the unsent commit) and `mine` (what it
shows). A text the door refuses, or one the server refused, stays in `mine`
marked `held` with the reason until its writer saves that file again; its
group waits with it, and other groups go. A group too large for one request
is held whole, never split. A pointer whose bytes the server does not hold
yet is owed: it stays saved, `sending` with "its bytes are uploading", and
its group waits, until the upload track (`client/uploads.ts`) finds the
bytes present; a refused upload holds it with why. A commit whose outcome the server
cannot know is put beside what is there as one block, held as "outcome
unknown". A delete or field removal that lost to an edit is not held: it is
an intent, not typed text, and the edited note stays, visibly. There are no
stored notices: a person reads the text, whose blocks say what was
contested, and each file's `FileStatus` (`synced`, `sending`, or `held` with
a reason). A request the server rejects (rate, size, form) holds no text;
the work stays committed and goes again.

**A device sends one commit at a time, on top of its position.** A save
commits at once while online; while a commit is in flight or the device is
offline, the unsent commit is amended. A ready commit goes before
notifications are read. Each answer (`PushAnswer`) is `applied`, `merged`,
`flushed`, `refused`, `rejected` or `outcome-unknown`, and an applied or
merged answer carries `main`'s texts for every path changed since the
commit's parent, so the device stands on `main` at once. A resend gets its
recorded answer, brought up to now.

**A device catches up by tree diff from its position.** Each commit on
`main` keeps the Git tree it left. `catchUp` answers the paths changed
between the device's position and `main`, with their hashes, in pages of
1,000, marking a path that was deleted since; the device reads the texts it
lacks by hash (`GET /blobs/<hash>`, immutable). Positions, commits and
answers are kept for `LIMITS.window` (10 minutes), and a landed commit's id
is recognized for `LIMITS.seen` (24 hours). A position older than the
window gets every file (`full`); a commit whose parent has left the window
is answered `outcome-unknown`; one recognized only by `seen` is answered
`flushed`.

**The server flushes live history into Git.** `createFlusher`
(`server/flush.ts`) writes one Git commit at `main`, plus one at each merge
that wrote a conflict block, so the value that lost is in Git's history. It
runs after 60 s with no push, at most 5 minutes after the last flush while
pushes go on, and at once when asked (`server.flush`). It is a journaled
state machine (intent, stage under a staging ref, compare-and-swap of Git's
`main`, complete, prune) that finishes a crash at any step. A flushed
commit's subject names its paths (`Edit notes/trip.md`, or
`Merge alice's change into notes/trip.md`), its body lists them, and its
trailers are `Epicenter-Live: <first>..<last> (<n> commits)` and a
`Co-authored-by` line per contributor; its author is the contributor with
the most live commits in it and its committer is `Epicenter`. Git's history
is first-parent: a live merge's second parent stays in live history. If
Git's `main` moved from outside, the flush stops as `diverged`, and
recovery is an operator's; Epicenter never rewinds or merges a `main` it
did not write.

**A `git push` keeps Git's ref rule, and is taken only while Git holds
every live edit.** `receive` (`server/receive.ts`) refuses a push whose old
value is not Git's `main` (`main-moved`: fetch and rebase), when a pushed
commit has other than one parent, and when any path a pushed commit changes
fails the door. It also refuses one while live edits are not in Git yet
(`unflushed`, which starts a flush so the client can fetch and retry): a
limitation of Epicenter's, not Git's, which can starve a push on a
repository someone is typing in, and which ADR-0697 keeps until a
measurement and a prototype decide. Accepted, the push becomes one live
commit on the live `main` Git holds, landing only if that is still `main`
in the transaction that applies it (otherwise `unflushed`), and that
transaction journals the move of Git's `main`, so a published `main` is
never rewound. While `unflushed` stands, a push always saw the current
bytes of every blob it replaces.

**A device keeps one WebSocket, and HTTP serves one-shot clients.**
`createWire` (`wire/wire.ts`) serves one repository:

```txt
GET    /socket          the device's WebSocket: push and catch-up up; head, commit events and replies down, in one order
POST   /tickets         a one-use ticket for the socket, for a browser that cannot set its headers
POST   /commits         a live commit, answered with its PushAnswer
GET    /files/<path>    main's text, its hash as the ETag, the commit it was read at as Epicenter-Commit
PUT    /files/<path>    If-Match: "<hash>", or If-None-Match: * to create
DELETE /files/<path>    If-Match: "<hash>"
GET    /catch-up        ?from=<commit>&to=&after=&path=...: one page
GET    /blobs/<hash>    a text by its Git blob hash, cached for good
POST   /info/lfs/objects/batch   Git LFS basic-transfer actions, and per-object errors
PUT    /lfs/objects/<oid>        a blob's bytes, streamed, verified and recorded once durable
GET    /lfs/objects/<oid>        a blob's bytes, streamed to a member
```

A request body has the wire's timeout plus its declared length at a
minimum rate to arrive, or gets 408. Uploads are bounded by the blob limit
(2 GiB) and the repository's quota (10 GB).

A commit's answer reaches its device before the commit's event reaches
anyone. A `commit` event names the commit, its parents and the changed
paths with hashes, never texts. A ticket opens one socket within 30 s, as
the session that asked for it, and is gone once presented.

**A replica is bound to one repository, server and account, and learns its
server once.** The socket's first message (`head`) names `main`, the
repository, the server's stable id, the account, the session's user, and
the server's `limits` on a push (its bytes and files) and on one blob.
The replica records these in `"epicenter/replica"`; a replica with no
server yet adopts the first one it meets for good, and a `head` that names
another repository, server or account is refused (`BoundElsewhere`).

## Consequences

- Devices run no Git. The replica's memory follows the work in flight, not
  the repository: no file's text is kept in memory, and every many-file
  question is an indexed query. Opening a 100,000-note replica took 6 to
  9 ms and 0.2 MB of heap in Bun; a full catch-up of 100,000 notes took
  2.3 s.
- No text writer, person or agent, is refused because of someone else,
  except at 1 MB, at 20 blocks, and in HTTP's conditional file write; a
  blob write is refused when the blob it replaces moved. Two people
  typing in the same words at once produce one block, which stays in the
  note and in Git until someone edits it away.
- Every value someone saved is in the shared text and in Git history,
  including the one that lost a field clash.
- A stale edit to a path that was deleted and reused lands in the new note
  as a block. Nothing is lost; it is visible and repairable, as in Git,
  which has no notion of a different note at one path.
- A device offline past the 10-minute window catches up with every file,
  and work whose outcome is unknown is held beside the text, never merged
  blindly.
- A clone reads the last flush, so it lags live history by up to a minute
  at rest and five minutes on a busy repository, unless the flush is asked
  for.
- The cost is concentrated in the server and in a small protocol of our
  own; the merge, the door and conflict grammar are pure `core/` code that
  the device, the server and the property tests share.

## Considered alternatives

- **Per-file writes conditioned on the file's hash, and a server that never
  merges** (the first shape of design B): a busy note starved its writers,
  and a hash could neither order writes nor tell a replacement note from
  the original.
- **Batches `{ device, n, changes }` with a per-device number:** the commit
  id makes a resend recognizable without a counter per device.
- **`move(from, to)`, refused if the destination is taken, with a week of
  each path's history so an edit follows a move:** path history was the
  largest cluster of rules; a rename is a delete and a write, and a stale
  edit to the old path keeps that note (a delete loses to an edit).
- **`append(path, text)` with no base:** every write names its parent, so
  the server always holds the base; a streamed reply is ordinary writes.
- **A `need-base` answer, with the device keeping and sending base texts:**
  the server keeps each commit's tree for the window.
- **An `expired` answer after a week offline, applying an edit only if its
  file was unchanged:** a 10-minute window with `outcome-unknown` and a
  full catch-up costs a download, not a rule about offline time, and holds
  the work beside the text.
- **Never merging a stale edit into a different note recreated at its path**
  (identity by creating commit, siblings saved beside it): dropped for the
  one `deletedSince` check, which appends the edit as a block.
- **Stored notices for overlaps, dropped field values and edits kept over a
  delete:** every conflict is text, and the only device state is `held`.
- **The current value winning a field clash, with the loser only reported:**
  the loser would reach no one else and no history.
- **Keeping `main`'s text when a merge would not parse:** the door admits
  only notes that parse, so a merge of three parsing notes by key parses.
- **A notification stream over server-sent events:** an open stream kept
  the Durable Object in memory (deployed spike 3); hibernating WebSockets
  were evicted with sockets intact and woke in about 30 ms, and carrying
  commits on the same socket removed the answer-versus-event ordering rules.
- **Committing to Git before acknowledging each write:** a flush to
  Artifacts cost about 2 s.
- **A writer mode, with agents' commits refused when `main` moved:** see
  [ADR-0697](0697-all-text-merges-from-everyone.md).
- **A conflicting `git push` merged by the server:** server merging stays on
  the commit path, where the answer can name the merge commit, until the
  push prototype in [ADR-0697](0697-all-text-merges-from-everyone.md) says
  otherwise.
- **Devices committing after a 0.5 to 2 s pause:** committing every save
  online measured p95 400 ms to the server at 10 typists, against 2.2 s.
- **IndexedDB as the device store:** writing 50,000 records took 17 s in
  Chromium.
- **A desktop folder retired in favor of the replica alone:** revisited by
  [ADR-0695](0695-one-sync-engine-runs-on-every-device-and-a-folder-on-disk-is-its-watched-projection.md).

## Verification

The property test (`packages/repository/src/sim/property.test.ts`, and
`wire.property.test.ts` over the real HTTP and socket wire) checks after
every step that nothing typed and acknowledged is lost, every shared note
parses, every device converges with the server, and hostile writes are
refused or bounded, and that an agent's batch lands in one commit or is
held whole; recent runs passed 500 fresh seeds at 200 steps in memory and
200 over the wire. The LFS round trip is tested locally, in Bun and in
Chromium and WebKit through Playwright. Deployed spikes 3 and 4 (outside the tree) proved the flush state
machine against Artifacts at every step boundary, the transport choice, and
R2 verifying a blob's SHA-256 on `put`. Before acceptance: the Durable
Object host with eviction mid-request, a `git push` through a real
receive-pack endpoint, the LFS round trip against R2, and the replica in the
browser's OPFS at 50,000 notes on a phone.
