# 0698. The file is the unit

- **Status:** Proposed
- **Date:** 2026-10-30
- **Amends:** [ADR-0697](0697-all-text-merges-from-everyone.md) at "A call's group lands whole", "A message belongs to its call", "A call has one outcome, and the replica reports it" and "Held means one thing" (a held save holds its call): there are no groups, calls, call outcomes or commit messages. Each file goes on its own. A file that cannot go waits or is refused alone, and a pointer waits only for its own bytes. ADR-0697 is edited to match.
- **Relates:** [ADR-0692](0692-every-write-is-a-live-commit-on-its-parent-taken-through-the-repositorys-server.md) (the live commit, which loses its optional message); [ADR-0695](0695-one-sync-engine-runs-on-every-device-and-a-folder-on-disk-is-its-watched-projection.md) (the folder engine, whose `epicenter commit` this deletes); [ADR-0696](0696-a-page-writes-a-repository-only-through-its-worker-over-collections-its-app-declares.md) (`repo.commit`, which stays as a local transaction).
- **Unbuilt:** nothing beyond ADR-0697's own Unbuilt line. Built in `packages/repository`: prototyped on branch `claude/file-is-the-unit`, merged into `claude/repository-v2` with the repairs below (phase 9g).

## Context

ADR-0697 made what one call saved a group that landed in one commit or was
held whole, and let a call carry a message that made its commit its own and
never amended. Building it took most of phases 8b to 9e. It needed call ids
on every level of every file, joins when a later save met a call's work,
outcomes per call, a message per call, cut rules in the flush for message
commits, the pairing of a rename's two halves, and `epicenter commit`.

That layer caused most of the replica's bugs in those phases. Messages
attached to a path rather than a level. A message went out under a later
call's words. A call was split across two commits by a join. A held call was
reported landed after old calls were forgotten. Calls were joined over a
blob refusal that did not stand. A pointer was sent before its bytes once
call rows replaced pair edges (seeds 470249 and 470282). Phase 9e then found
a case where three of its own rules cannot all hold once groups cross-join:
a message commit is never amended, a group lands whole, and a later save of
a held group joins it. One message then names two commits, and every fix
needs an "except when".

Each of those bugs is about which files must travel together. None is about
whether a file's text is kept. The owner chose repairability: a person
repairs a file, so a file is what waits.

## Decision

**The unit is the file.** A device has one unsent commit carrying every file
it changed. When it sends, each file that can go, goes, once its text has
been quiet for a short pause. A file that cannot go stays alone, with its
reason, in one of two states: `waiting`, which the system clears (bytes
uploading, or a size or bound), or `refused`, which only a person can fix
(an unportable name, a name another file has in other letters, a note that
is not text, a file where a folder is or the reverse). A pointer whose
bytes the server does not hold waits alone for them, saved and out of the
unsent commit, until the upload track says they are present. Nothing waits
for another file.

**A rename is a delete and a create, independent; there is no rename
pairing.** If the new name cannot go (an unportable name, or one that folds
to another file's), the delete lands and the text waits in the new file,
refused, on the device that renamed it, until its person renames it again.
The owner accepted that cost: the text lives on that one device meanwhile.

**There are no commit messages.** A live commit carries its author (user and
device) and its files. History says who wrote each change, and conflict
blocks name the writer as `user/device`, so an agent keeps its label.

**`repo.commit` is a local transaction.** It checks every path and seals
every blob first, then stores all of its writes or none, and the page hears
it as one change. From there each file goes on its own. It stays because a
page should never show half of its own batch, and a crash should never store
half of it.

**`epicenter commit` is gone.** Without a message or a call outcome, it only
read every difference from the record and sent it. `epicenter sync --once`
does exactly that, after catching up first, so it is "send now". It reports
how each file it sent landed, and each file waiting or refused with its
reason, and exits 2 while anything waits, is refused or is pending.

**A request too large goes in halves.** The next commit takes half as many
files, and one file too large to go alone waits with the server's reason.

## Repair over refusal

The repository repairs what it can represent and refuses only what it
cannot represent or cannot afford (review-repair, agreed by three
reviewers and the owner; built in phase 9g):

- **A note is always valid.** A text that does not open with parseable
  frontmatter is a note with no fields, its whole text the body; a schema
  reports its fields missing. Nothing holds a note for its frontmatter. A
  merge of three notes whose frontmatter parses writes frontmatter that
  parses (a seeded property). A folder normalizes CRLF and a byte order mark
  as it reads, records the file's own hash, and never writes it back only to
  normalize it.
- **A blob write that lost lands beside.** The server puts a losing create
  or stale replace at a sibling, `<stem> (conflict <hash7>).<ext>`, named
  from the original stem and the losing bytes' hash, allocated idempotently
  against the whole resulting tree; the answer, and a `git push`'s, names
  it. A device that knows its write lost says what it was made over
  (`over`); it never names the sibling.
- **Work whose outcome is unknown goes** as one labelled conflict block after
  what is there, instead of being held.
- **A device may claim any time.** Its claim is Git's author date; the
  server's arrival time drives retention and the flush; no commit is
  refused for a clock.
- **Every note lands in house style.** The server formats each landing
  note's frontmatter one way, deterministically and idempotently, the body
  untouched; merges commute with it. Devices send what was typed; a folder
  writes the formatted text back once.
- **Each file says how it landed:** as sent, with conflict blocks, at a
  sibling (with its path), or a delete that did not take, in the replica,
  the API and `sync --once`.
- **A file is sent once quiet.** Every save is stored at once; the replica
  sends a file after its text has been quiet for 1.5 s, never as a hold.
- **Storage that is not persistent is said.** A browser that holds work
  existing nowhere else asks for persistent storage, and where it is not
  persistent, the shell's repository bar says the browser may delete it.

Must stay refusals: size and parse-cost bounds, rate, `merge-too-large`,
the block cap, pointers without bytes, text that is not UTF-8, NUL,
unportable paths, `.git`, control files, case twins, auth, commit id and
author checks, a path named twice, a `git push` behind Git's `main`, and
HTTP's `If-Match`.

## What was deleted

Line counts are from the prototype's diff against `c121bc19a6`.

- **The replica's calls** (`client/replica.ts`, 1,783 to 1,493 lines): the
  `"epicenter/calls"` table and the `call` columns (dropped on open);
  `newCall`, `callOf`, `messageOf`, `join`, `note`, `blocker`,
  `blockedCalls`, `savedReady`, `callOfMine`, `oneCall`, `working`,
  `outcomeOf`, `calls()`, `CallOutcome`, and `batch`, which existed to keep
  calls apart during a scan. `sized`, `cut`, `writeAll`, `takeBack` and
  `onRejected` lost their call and message branches.
- **Messages end to end:** the commit's `message` and its canonical form,
  the wire schema field, history's column, the merge that carried a message,
  the flush's cut before and at a message commit, and the `Epicenter-Device`
  trailer, which only message commits had.
- **The folder engine's grouping** (`folder/engine.ts`, 895 to 840 lines):
  `Call`, `groupFound` (the rename pairing) and `engine.commit`.
- **`epicenter commit`** (`bun/folder-commands.ts`, 155 to 95 lines), its
  `landed`, `unchanged` and per-call lines, `commitFolder`, and `-m`.
- **`repo.commit`'s `message` option**, threaded through the session, the
  worker, the page and `bytes.put`.

Package source went from 14,840 to 14,424 lines and tests from 10,016 to
9,667, counting three merge fixes and the new tests the prototype added.

## What is no longer promised

- **All-or-nothing batches.** A batch's files can land in different commits,
  and some can land while others are held. Another device can see half of an
  agent's batch.
- **A rename lands whole.** A rename whose new file is held removes the old
  file from the server while the text waits on one device. If that device's
  storage is lost before the file is fixed, the text goes with it, as any
  unsent work does.
- **A note waits for the blob it names.** A note saved with a new blob can
  land before the blob's bytes are uploaded, naming a file that is not there
  yet.
- **Commit messages.** Git history is the flush's generated subjects and
  co-authors; an agent's label is in live history and in conflict blocks,
  not in a Git trailer.
- **A writer's call outcome.** A caller reads each file's state (synced,
  sending, or held with a reason), not what became of one call; there is no
  `landed` line naming the commit or the conflicts one call wrote.

## Consequences

- One rule for what waits: a file, with its own reason. A person repairs the
  file in front of them; no file says "saved with X, which is held".
- The cross-join cycle phase 9e stopped on cannot occur: nothing joins.
- An agent that needs its files to appear together must make each file
  stand alone, or write one file that names the others.
- Sending is as fast as before. 1,000 changed notes in a folder of 10,000
  are read into the replica in 154 to 168 ms by `sync --once`'s scan and
  sent in one push in about 100 ms (`scripts/bench-folder.ts`); the deleted
  `epicenter commit` took 116 ms to its group and 107 ms to its answer. In
  memory, one device saves and sends 1,000 notes in about 26 ms each, as
  before.
- The property tests check that held files are held alone with a reason,
  that no token appears twice outside conflict blocks, that no pointer is
  sent before its bytes, and that devices and folders converge. Their
  per-step check now allows an acknowledged token to wait in a device's
  own unsent work (a rename's held new file), and quiescence stays strict.
  The stronger duplicate check found three pre-existing merge bugs, each
  a line or word glued to its neighbour, fixed with the prototype.

## Considered alternatives

- **Keep groups, drop messages** (ADR-0697 without its message rules): this
  removes the cycle, but keeps call ids, joins, per-call blockers and the
  rename pairing, which caused most of the bugs that had nothing to do with
  messages.
- **Keep messages as metadata on whatever commit next carries a file:** a
  message would then describe a commit holding files it never named. It is
  the misattribution the message rules existed to prevent.
- **Keep `epicenter commit` as an alias of `sync --once`:** two names for
  one action, and the old name promises a commit the command no longer
  makes.
- **Delete `repo.commit`:** a page would then show a batch half-applied
  while it is stored, and a crash could store half of one. The local
  transaction is cheap and has no wire meaning.
