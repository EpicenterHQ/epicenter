# 0692. Every write carries its base, and the repository's server takes it

- **Status:** Proposed
- **Date:** 2026-10-29
- **Would supersede:** [ADR-0622](0622-a-losing-edit-stays-a-parent-of-the-merge-commit.md) (the last edit to reach `main` wins each unit, and Epicenter writes no conflict marker): a clash is a conflict block in the note; [ADR-0529](0529-commits-happen-only-on-sync-or-when-a-person-saves-a-version.md) (a commit happens only at sync or when a person saves a version): the server flushes live history into Git on its own schedule.
- **Would amend:** [ADR-0619](0619-every-byte-epicenter-keeps-is-a-git-object-a-working-file-an-access-list-row-or-a-cache.md) at "Repository content has one committed history: Git": live history runs ahead of Git until the next flush; [ADR-0534](0534-data-folders-are-the-only-data-model.md) at the device's copy: a device holds a replica database of the repository's files, not a folder it writes through; [ADR-0621](0621-epicenters-library-writes-only-text-to-a-repository-in-v1.md) at binary files ("Git LFS pointers ... are not designed"): every file that is not a note is a canonical LFS pointer, at any path an app names.
- **Relates:** [ADR-0620](0620-history-in-a-repository-only-grows.md), whose rule `main` keeps; [ADR-0695](0695-one-sync-engine-runs-on-every-device-and-a-folder-on-disk-is-its-watched-projection.md), which runs the replica on every device and decides that typing is safe once it reaches the engine; [ADR-0693](0693-repositories-are-addressed-and-every-page-is-an-owner-a-repository-or-an-app-on-one.md) (what a repository and its address are); [ADR-0696](0696-a-page-writes-a-repository-only-through-its-worker-over-collections-its-app-declares.md) (the app API over the replica); [ADR-0697](0697-all-text-merges-from-everyone.md) (all text merges, from everyone: the one write rule this record runs, a `git push` included); [ADR-0457](0457-a-row-filename-is-its-exact-id-and-a-title-is-a-field.md) (a path is a note's identity); [ADR-0632](0632-a-lens-belongs-to-its-reader.md) (the server reads no schema).
- **Unbuilt:** the hosted server (a Durable Object host, Cloudflare Artifacts as `GitObjects`, R2 for blob bytes behind presigned uploads); a `git push` transport into `receive` (the receiver and its checks are built, no receive-pack endpoint is); accounts and membership (the development server makes anyone the owner their `Authorization: Bearer <name>` names); the GitHub mirror and Action. (The `epicenter sync` command agents run is built in `packages/repository`.)

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

Naming that state, the parent, then made correctness depend on time: the
server kept parents for ten minutes, a write whose parent had left was
answered `outcome-unknown` and resent as a labelled block, and a resend was
recognized for a day. The review that followed (two worlds, Oct 30) returned
to a base per file, now in one hash space and read from the store or from
Git, so a write merges against what it saw however old that is, and to a
numbered push, so a resend is answered exactly. The rules that sank the
first draft stay out: a write's outcome is a merge, never a refusal for a
moved hash, and the owner accepted that nothing tells a note made again at
a path from the one before it.

## Decision

**Every write is one file saying what it saw, and the server for the
repository takes it.** A write (`FileWrite`, `packages/repository/src/core/commit.ts`)
names a path, its `base` (the Git blob hash of the version its writer last
saw there; null: none) and what the file is now. A device sends its writes
in a numbered push:

```txt
{ user, device, epoch, seq, time, from,
  files: [{ path, base, next: { text } | { blob: { oid, size } } | { deleted: true } }] }
```

One hash space names every version: a note's is the Git blob hash of its
text, a blob's the Git blob hash of its canonical LFS pointer. Pointer text
exists only at the Git edges (the server's store and Git, and the replica's
own rows); apps and the wire carry a blob as `{ oid, size }`. The kind comes
from the path (`.md` is a note) and must agree with `next`, checked once at
the door (`kindRefusal`); no code after it asks a write what it is. `time`
is the device's claim, any ISO instant: a label people read in conflict
blocks and Git's author date, never an order. `from` is the device's
position, so the answer brings what changed since. A rename is a delete of
the old path and a write of the new one, each going on its own
([ADR-0698](0698-the-file-is-the-unit.md): the file is the unit).

**Each device's pushes are numbered, so a resend is answered exactly.** A
device's database chooses an `epoch`, and stores each push's `seq` with the
push before sending it. The server keeps one row per writer's epoch (user,
device, epoch): the last seq, that push's hash, and its answer (without
file contents, which a resend reads again by hash). That push sent again,
seq and hash equal, gets that answer. An earlier seq, or that seq with other
writes, answers `behind`: this device is behind itself, as a database
restored from a copy is. The device then takes a new epoch, catches up, and
every file with work it has not had answered forgets its base: it cannot
know what its last writes left, so that work merges as a write over no file
(a note's goes after what is there as one block, unless it is already there;
a blob's lands beside a different one; a delete does not take). That is the
only way a write over an existing file has a null base; the server never
drops a writer's claim. A request the server rejects (rate, size, its form)
is not a push the writer made: it is not recorded, and goes again under its
seq. A one-file HTTP write is its own push, a fresh epoch at seq 1. The
number names a push, not a file: a push of many files whose answer was lost
must be recognized whole.

**`main` only moves forward, and each write meets `main` against its own
base** ([ADR-0697](0697-all-text-merges-from-everyone.md)). A note whose
base is `main`'s version lands as written; any other merges with `settle`
(`core/settle.ts`) against its base's text, and a base of null where a note
is is a second create. A blob lands by compare-and-swap of versions
(`settlePointer`). Each push lands as one live commit on `main` (its parent
the `main` before it), authored by its writer; it is `applied` when every
write landed as sent, else `merged`. A commit carries no mode: who wrote it
changes its label, never how it settles. The server reads a base's text from
its store or from Git, checked against the hash. RULE: a text stays in the
store until Git has it (a flush or a push put it there), whatever names it,
and is then read from Git; while one is read, the push is answered
`reading` and the device sends it again. A base Git does not have either is
refused (`unknown-base`): no honest writer can name one. No time decides
what a write does. A one-file HTTP write (`PUT` with `If-Match`,
`If-None-Match: *` to create, `DELETE` with `If-Match`) is a write over
`main`'s version with that precondition, checked inside the server's
transaction: HTTP's conditional write, the one text write refused
(`file-moved`) because of someone else's write. A one-shot client that wants
merging reads a file (`GET /files/<path>`, whose ETag is its version) and
posts a write over that version to `POST /writes`.

**A blob never merges, and a blob write that lost lands beside it.** A blob
write lands only where the path still holds the version its writer saw (its
base). A create or replace that does not lands at a sibling the server
names, `<stem> (conflict <hash7>).<ext>`, from the original stem and the
losing bytes' hash: allocated idempotently (equal bytes are one file)
against the whole resulting tree, taking more of the hash where a name is
held by other bytes, a folder or another spelling. A race at a sibling
makes another sibling of the original stem. The answer names each sibling
(`siblings`), and so does a `git push`'s. References to the original file
are not repaired; the outcome tells the writer. A delete that does not land
leaves the file.

**Every conflict is text.** `settle` runs the Epicenter merge (`core/merge.ts`):

- A note is a header and a body, by position: the header is the text
  between a `---` first line and the next `---` line, whether or not it
  parses; with no closing fence there is none, and the whole text is body.
  Header merges with header and body with body: a header's lines never
  move into the body.
- The header is a list of key blocks, found by position, never by `yaml`'s
  error recovery: a line at column 0 (not blank, not a comment, not a `- `
  item) starts a key's block, which runs to the next one; comment lines
  belong to the key below them. Each block is read on its own: **a broken
  key costs only that key** (an issue on that key, like a schema issue), a
  key held twice is an issue on that key, and every other key is a field.
- The header merges by key, each key's block whole and compared as text,
  whether or not it parses. When both sides change one key, the later
  arrival at the server wins: in `merge`, `incoming` is the write arriving
  now and `current` is `main`, so `incoming`'s block wins. Never a device
  clock. No block is written; the value that lost stays in history. A key
  deleted on one side and edited on the other keeps the edit.
- A patch replaces the key's block (its value set in place where it
  parses, so its comments stay), appends it, or removes it; every other
  line stays as typed, so a patch works on a header that does not parse. A
  note with no header gains one. House style prints each key that parses
  and leaves a broken key exactly as typed. Merges, patches and house style
  never break a key that parses, and never write a key twice (a seeded
  property); only typed text breaks a key.
- The body merges by line, so edits on neighboring lines do not conflict.
  Lines both sides changed merge again by word. What still overlaps is a
  conflict block.
- A delete against an edit it had not seen keeps the edit, and an edit
  brings a deleted note back.
- Two creates at one path keep the note that is there and append the
  incoming text whole as one block. A note deleted and created again since
  a write's base merges by its content, as an edit of the note the base
  names: nothing tells the two apart (there are no generations), a visible
  and repairable result the owner accepted.
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
the door's rules.** `admit` and `admitFiles` (`server/server.ts`) check, in
order:

| Check | Refused as |
| --- | --- |
| A session, a member, not a `reader` | `no-session`, `not-member`, `reader` |
| Pushes per member, a bucket of 30 refilled at 10 a second | `rate` |
| `user` is the session's user | `not-author` |
| `time` is an ISO instant | `bad-time` |
| At most 4 MB as JSON, 1,000 files, one entry per folded path | `too-large`, `too-many-files`, `path-twice` |
| Its place in its writer's numbered pushes (above) | the recorded answer, or `behind` |
| A path at most 512 bytes | `path-too-long` |
| `next` is the kind its path names (`kindRefusal`) | `inadmissible`, with why |
| `admissible(path, text)` (`core/door.ts`), below | `inadmissible`, with the door's reason |
| A pointer's bytes present at its size | `blob-missing` |
| A base's text, where a note merges against it | `reading` while Git is read; `unknown-base` |
| A name is a file or a folder, never both, over what `main` becomes (`collision`, `core/tree.ts`) | `is-a-folder`, `under-a-file` |

`admissible` is one pure predicate the device, the server and a GitHub
Action share. A note (`.md` in any case) uses LF with no byte order
mark, is at most `MAX_FILE_BYTES` (just under 2 MB, below), is never an LFS pointer, and its frontmatter holds at
most `FRONTMATTER_KEYS` (1,000) keys and `FRONTMATTER_VALUES` (10,000)
scalars, nested at most `FRONTMATTER_NESTING` (64) deep. Every text is valid
UTF-8 with no NUL, and every file that is not a note is a canonical LFS
pointer naming at most 2 GiB (`MAX_BLOB_BYTES`). Paths are NFC, hold no `.git` component, are legal on Windows and
macOS, and keep each segment within 255 bytes; Epicenter alone writes
`.gitattributes` (`ATTRIBUTES`: every file through LFS, notes and the file
itself as text), `.lfsconfig`, `.gitmodules` and `.epicenter/`, and no
folder takes one of those names. `lint`
only warns: unresolved or malformed conflict blocks, a path over 260 bytes. A name is a file or a folder, never both: a file written where a
folder still holds files is refused at that file as `is-a-folder` ("a folder
already has this name"), and one written beneath a file as `under-a-file` ("a
file already has this name"), checked over what `main` would become. A delete names only a
file. Only a person renaming one can fix such a refusal, so the device marks
the file `refused`, and a tree update that meets a collision
throws rather than drop either side. A merge result passes `admissible` too,
and one named exception refuses a text writer because of someone else: a
merge that would leave more than `BLOCK_CAP` (20) conflict blocks in a note
(`too-many-blocks`, "this note has unresolved conflicts; resolve some
first"). The server reads no schema.

**One size limit, on what is stored.** A note is at most `MAX_FILE_BYTES`
(`core/door.ts`): a Cloudflare Durable Object's SQLite holds a row, string
or BLOB of at most 2 MB, read as 2,000,000 bytes, and the limit leaves
16 KiB of that for the row's other columns. A note a person writes past it
waits on their device ("over the size limit") until it is shortened. A
merge whose result would pass it does not happen: `main`'s note stays, and
the arriving version lands beside it as `<stem> (conflict <hash7>).md`,
from the note's Git blob hash, allocated as a blob's sibling is (against
the whole tree, idempotent: equal texts are one file). What is on `main`
stays and the arriving write moves beside it, as for blobs; fields still
let the later arrival win. A device whose own rebase of its work would pass
the limit leaves that work over the version it was made on, for the server
to judge the same way. A writer's last answer is kept without file
contents, so its row stays small whatever the push carried.

**A file is one name, and its spelling is fixed when it is created.**
Paths equal after NFC and case folding (`fold`) are one file, stored once
under its folded path: on the server as `main`'s spelling of it, on a
device as one replica row with its spelling as a column. On disk and in Git
a path stays as written. A write through any capitalization of an existing
file is a write to that file: its text merges like any other write, and the
file keeps its spelling. So is a delete and a create of one folded name
before the delete lands, in one save or offline. To change a file's case,
delete it, let the delete land, and create it again. A `git push` that
changes only a file's capitalization (removes one spelling of a path and
adds another) is refused: "a file's capitalization can't change; delete it
and create it again", one more name that cannot exist. Every listing (an
answer, a notification, a catch-up) names a file once, in `main`'s
spelling, so a device takes `main`'s spelling as it takes its text. A
folder keeps its records per spelling on its disk, where a case-sensitive
file system can hold two; it refuses the second until a person renames one.

**A note is always valid.** A broken key costs only that key: the note
keeps every other field, its body is what follows the header, and an app's
schema reports the broken key as an issue.
Nothing refuses or holds a note for its frontmatter, and a merge of three
notes never breaks a key that parses (a seeded property). A folder reads a note's CRLF line endings and byte order mark as
LF with none, keeps the file's own hash in its record, and never writes the
file back only to normalize it.

**Every note lands in house style.** The server prints each landing note's
frontmatter one way (`formatMarkdown`: `yaml`'s printer over the document as
written, so comments, key order and quoting are kept, new keys appended by
the merge; the body never touched), deterministically and idempotently, and
merges commute with it. Devices send what was typed; a folder writes the
formatted text back once, by its ordinary projection.

**A device repairs what the repository can represent, and refuses only what
it cannot.** The replica (`openReplica`, `client/replica.ts`) keeps four
levels per file: `base` (the text at its position), `sent` (in the push
awaiting an answer), `committed` (in the unsent commit) and `mine` (what it
shows). Each level of work carries the version it was made over, which its
write sends as its base: a note's work is rebased as `main` moves, so its
version is the base's (unless its rebase would pass the size limit, when it
is left for the server); a blob's keeps the version its writer saw until the
server judges it. Each file goes on its own. One that cannot go now stays in `mine`
with its reason, alone, as one of two states (`FileStatus`): `waiting`, which
the system clears (bytes uploading or refused by size or quota, a request,
merge or block bound, a text the door's other rules refuse), or `refused`,
which only a person can fix: an unportable name, a name another file has in
other letters, a note that is not text, or a file where a folder is or the
reverse (`onlyAPersonFixes`, `core/door.ts`). Only its writer's next save of
that file clears it. A pointer whose bytes the server does not hold yet is
owed: it waits, "its bytes are uploading", until the upload track
(`client/uploads.ts`) finds them present. A delete or field removal that lost to an edit is not
held: it is an intent, not typed text, and the edited note stays, visibly.
There are no stored notices: a person reads the text, whose blocks say what
was contested, each file's state (`synced`, `sending`, `waiting` or
`refused`), and how each file it sent landed (`outcomes`: as sent, with
conflict blocks, at a sibling with its path, or a delete that did not take).
A request the server rejects (rate, size, form) holds no text; the work
stays committed and goes again, a request too large in halves.

**A device sends one push at a time, from its position.** A save is
stored at once; a file is sent once its text has been quiet for
`SEND_QUIET` (1.5 s), a pause and never a hold, so a burst of keystrokes
lands as one text. While a push is in flight or the device is offline,
the unsent commit is amended. A ready push goes before notifications are
read. Each answer (`PushAnswer`) is `applied`, `merged`, `refused`,
`rejected` or `behind`, and an applied or merged answer carries `main`'s
files for every path changed since the push's `from` and every path it
touched, so the device stands on `main` at once; where `from` has left
history it carries only what the push touched (`stale`), and the device
catches up in full. A resend gets its recorded answer.

**A device catches up by tree diff from its position.** Each commit on
`main` keeps the Git tree it left. `catchUp` answers the paths changed
between the device's position and `main`, with their hashes, in pages of
1,000; the device reads the versions it lacks by hash (`GET /blobs/<hash>`,
immutable). Positions are kept for `LIMITS.window` (10 minutes), and a
position older than the window gets every file (`full`). The window bounds
only how a device learns what changed: no write's outcome depends on it.

**The server flushes live history into Git.** `createFlusher`
(`server/flush.ts`) writes one Git commit at `main`, plus one at each merge
that wrote a conflict block, so the value that lost is in Git's history. It
runs after 60 s with no push, at most 5 minutes after the last flush while
pushes go on, and at once when asked (`server.flush`). It is a journaled
state machine (intent, stage under a staging ref, compare-and-swap of Git's
`main`, complete, prune) that finishes a crash at any step. Staging writes
every object the flush adds as one pack with the staging ref, in one
request (`GitObjects.writePack`, Git's receive-pack), so a flush holds Git
for the same five requests however many commits it writes. A flushed
commit's subject names its paths (`Edit notes/trip.md`, or
`Merge alice's change into notes/trip.md`), its body lists them, and its
trailers are `Epicenter-Live: <first>..<last> (<n> commits)` and a
`Co-authored-by` line per contributor; its author is the contributor with
the most live commits in it and its committer is
`Epicenter <noreply@epicenter.so>`. Git's history is first-parent: a live
merge's second parent stays in live history. If Git's `main` moved from
outside, the flush stops as `diverged`, and recovery is an operator's;
Epicenter never rewinds or merges a `main` it did not write.

**A `git push` keeps Git's ref rule, and merges like any write.**
`receive` (`server/receive.ts`) checks Git's own rule exactly: the push's
old value must be Git's `main` (otherwise `main-moved`: fetch and rebase).
Every pushed commit must have one parent and pass the door, and a pointer's
bytes must be on the server. Live edits Git does not hold yet are no reason
to refuse. Each file the push changes becomes a write whose base is its
version in the push's old value, which Git has, so every base is readable.
They land on live `main` as one commit, like any writer's: every note
merges, and a blob by compare-and-swap, landing beside a live write it
lost to.
The transaction that lands it journals the move of Git's `main` from the
old value to exactly the pushed commit, and records the push in the
`received` table. Git's `main` moves only after that, by compare-and-swap,
so a published `main` is never rewound. The journal claims only what Git
holds: a push applied with nothing live ahead of it moves the flushed place
to `main`; a push merged over live edits leaves the flushed place where it
was and leaves a join. The answer is `accepted`, with the pushed commit
(`main`), Git's head, whether it was `merged`, and `published` (false only
while a flush is diverged). A push sent again, its answer lost or the server
crashed after taking it, finds its row in `received` and is answered
`accepted` again, never taken twice.

**The next flush joins a merged push to the live edits it was merged
over.** It writes those edits as a side chain from the push's old value
(the commit Git's `main` was when they were made, so each commit is a state
that existed), with conflict-block and labelled-message commits as usual.
It then writes one join commit, whose first parent is the pushed commit and
whose second is the side chain's tip, with the live merge's tree. `git log
--first-parent` therefore runs through every push, and no commit after a
push has a tree made without it. A join is authored by
`Epicenter <noreply@epicenter.so>`, with every writer it merges in as a
`Co-authored-by`; its pusher authored the pushed commit. A second push from
the first pushed commit before the flush is taken under the same ref rule,
its bases read from the first pushed commit.

**A waiting join is kept by the window, like all live history.** Once the
window drops a join's place, its pushed commit stands as the state, and the
next commit on it carries the live edits it was merged over, coarser, as
any history the window dropped reaches Git. In practice a join waits for
one scheduled flush (at most 5 minutes while pushes go on), well inside the
10-minute window; only a stopped flush (`diverged`, or Git unreachable)
lets the window pass.

**A device keeps one WebSocket, and HTTP serves one-shot clients.**
`createWire` (`wire/wire.ts`) serves one repository:

```txt
GET    /socket          the device's WebSocket: push and catch-up up; head, commit events and replies down, in one order
POST   /tickets         a one-use ticket for the socket, for a browser that cannot set its headers
POST   /writes          a push of writes, answered with its PushAnswer
GET    /files/<path>    main's note text, or a blob's { oid, size } as JSON; its version as the ETag
PUT    /files/<path>    If-Match: "<hash>", or If-None-Match: * to create (a blob's body is { oid, size })
DELETE /files/<path>    If-Match: "<hash>"
GET    /catch-up        ?from=<commit>&to=&after=&path=...: one page
GET    /blobs/<hash>    a version by its Git blob hash, as JSON content, cached for good
POST   /info/lfs/objects/batch   Git LFS basic-transfer actions, and per-object errors
PUT    /lfs/objects/<oid>        a blob's bytes, streamed, verified and recorded once durable
GET    /lfs/objects/<oid>        a blob's bytes, streamed to a member
```

A request body has the wire's timeout plus its declared length at a
minimum rate to arrive, or gets 408. Uploads are bounded by the blob limit
(2 GiB) and the repository's quota (10 GB).

A push's answer reaches its device before its commit's event reaches
anyone. A write's answer is 200 applied or merged, 409 behind, 422 a refused
write, and for a rejected request 412, 413, 422, 428, 429 rate, 503 while a
base is read from Git, or 401 and 403. A `commit` event names the commit, its parents and the changed
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
  except at 20 blocks, in HTTP's conditional file write, and where someone
  made a file or a folder of the same name; a blob write that lost, and a
  note merge that would pass the size limit, land beside the file. Two people
  typing in the same words at once produce one block, which stays in the
  note and in Git until someone edits it away.
- Every line someone saved is in the shared text and in Git history. A
  field value that lost to a later write of its key is in Git history.
- A stale edit to a note that was deleted and created again merges into
  the new note by its content, as an edit of the one it saw. Nothing is
  lost; it is visible and repairable, as in Git, which has no notion of a
  different note at one path.
- A device offline for any time merges each write against the version it
  saw, read from the store or from Git; it catches up with every file once
  its position has left the 10-minute window. A lost answer is answered
  exactly, so nothing lands twice. A database restored from a copy is told
  it is behind itself, and its unanswered work goes as a write over no
  file: where that work had landed, nothing repeats; where it had not, a
  note's goes after what is there as one block.
- Every version a writer may have seen stays in the server's store until
  Git has it. Versions `main` held between two flushes never reach Git, so
  they stay: correct for every base, at a storage cost that grows with
  edits between flushes.
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
- **Every write a live commit on its parent, the state it was made on (this
  record's rule until each write carried its base):** the server merged
  against the parent's tree, which it kept for a 10-minute window, so a
  write whose parent had left it could only be answered `outcome-unknown`,
  and the device sent its work again as a labelled block; a resend was
  recognized by commit id for a day, then answered `flushed`. Correctness
  depended on time. A base per file, read from the store or Git, and a
  numbered push remove the window from every write's outcome.
- **A seq per file write:** a push of many files whose answer was lost would
  read as a device behind itself; the number names the push.
- **Taking a base the server cannot find as null:** it would drop a writer's
  claim and turn its edit into a block; the server reads Git instead, and
  refuses only a base no history holds.
- **A rename mark that let a write change a file's spelling (one row per
  name, piece 1):** it needed its own landing rule and a push-as-rename
  rule; a spelling fixed at creation needs neither.
- **Refusing a merge that would grow a note past 1 MB (`merge-too-large`),
  holding it on its writer's device:** the text lived on one device; it now
  lands beside the note, and the one limit is on what is stored.
- **`move(from, to)`, refused if the destination is taken, with a week of
  each path's history so an edit follows a move:** path history was the
  largest cluster of rules; a rename is a delete and a write, and a stale
  edit to the old path keeps that note (a delete loses to an edit).
- **`append(path, text)` with no base:** every write names its base, which
  the server always holds or reads from Git; a streamed reply is ordinary writes.
- **A `need-base` answer, with the device keeping and sending base texts:**
  the server keeps every version until Git has it, and reads Git after.
- **An `expired` answer after a week offline, applying an edit only if its
  file was unchanged:** a write merges against its base however old.
- **Never merging a stale edit into a different note recreated at its path**
  (identity by creating commit, siblings saved beside it), or the
  `deletedSince` check that appended it as a block: a base names a version,
  not a time, so the server cannot know of a delete since it; the owner
  accepted the merge by content. Siblings are kept for blobs, which never
  merge.
- **Stored notices for overlaps, dropped field values and edits kept over a
  delete:** every conflict is text, and the only device states are
  `waiting` and `refused`.
- **The current value winning a field clash, with the loser only reported:**
  replaced by the later arrival winning, with no report and no block: the
  loser is `main`'s earlier value, already in history.
- **The current value winning a field clash, with the loser written into the
  body as a block (this record's rule until the header merged by key):** a
  field's block could not be continued except by matching text, and two
  headers written at once over a note whose header did not parse merged as
  lines into duplicate keys.
- **Refusing a note whose frontmatter does not parse, and holding it on its
  device:** a note half typed could not sync, and two repairs of one never
  met; a note is always valid instead, and a merge of three notes whose
  frontmatter parses writes frontmatter that parses.
- **A row per spelling on the device, moved to `main`'s spelling as it
  arrived:** a catch-up of another spelling made a second row, and work
  saved over a create in flight under another spelling went over `main`
  unseen; with one row per name neither can happen, and the moving rule
  (`respell`) is gone.
- **A generation per path, bumped at each delete and create, so a note made
  again at a path is another note:** the owner accepted a stale write
  merging into a note made again at its path as a visible, repairable
  result, and a generation would be kept for every path forever.
- **Holding a blob write that lost, with why:** its writer had to keep the
  bytes under another name by hand; the server names a sibling instead.
- **Refusing a commit dated ahead of the server's clock:** a device's clock
  is a claim; nothing time-based reads it.
- **A notification stream over server-sent events:** an open stream kept
  the Durable Object in memory (deployed spike 3); hibernating WebSockets
  were evicted with sockets intact and woke in about 30 ms, and carrying
  commits on the same socket removed the answer-versus-event ordering rules.
- **Committing to Git before acknowledging each write:** a flush to
  Artifacts cost about 2 s.
- **A writer mode, with agents' commits refused when `main` moved:** see
  [ADR-0697](0697-all-text-merges-from-everyone.md).
- **A `git push` refused while live edits are not in Git (`unflushed`):**
  it starved a push on any repository someone was typing in; see
  [ADR-0697](0697-all-text-merges-from-everyone.md) for the measurement and
  the other push shapes considered.
- **Sending every save at once:** committing every save online measured
  p95 400 ms to the server at 10 typists, against 2.2 s for a 0.5 to 2 s
  pause; the owner chose the pause (1.5 s quiet) so a burst lands as one
  text, accepting that latency.
- **IndexedDB as the device store:** writing 50,000 records took 17 s in
  Chromium.
- **A desktop folder retired in favor of the replica alone:** revisited by
  [ADR-0695](0695-one-sync-engine-runs-on-every-device-and-a-folder-on-disk-is-its-watched-projection.md).

## Verification

The property test (`packages/repository/src/sim/property.test.ts`, and
`wire.property.test.ts` over the real HTTP and socket wire) checks after
every step that nothing typed and acknowledged is lost, every device
converges with the server, no token appears twice outside conflict blocks,
what a device has not sent waits or is refused alone with a reason, and
hostile writes are refused or bounded (a forged author, a write of the wrong
kind, a push replayed under its seq with other writes, a flood of writes
over no base); piece 2's runs are in its report. `sim/base.test.ts` checks a
device away for a week merging against a base kept live and one read from
Git, a lost answer resolving exactly, a restored database neither applying
an old change twice nor losing unsent work (notes, blobs and deletes), a
note deleted and created again merging by content, and notes and blobs in
one push. `server/receive.test.ts` runs a `git push` against a
real bare repository through every hazard (a push behind live edits, a save
during its checks, a stale blob, conflict cuts and labelled commits before
it, a second push from the first, a join outliving the window, a crash at
each push and export step), each ending in `git fsck --strict`, and a
randomized test interleaves saves, pushes, flushes, crashes and time past
the window (1,000 fresh seeds pass). The LFS round trip is tested locally, in Bun and in
Chromium and WebKit through Playwright. Deployed spikes 3 and 4 (outside the tree) proved the flush state
machine against Artifacts at every step boundary, the transport choice, and
R2 verifying a blob's SHA-256 on `put`. Before acceptance: the Durable
Object host with eviction mid-request, a `git push` through a real
receive-pack endpoint, the LFS round trip against R2, and the replica in the
browser's OPFS at 50,000 notes on a phone.
