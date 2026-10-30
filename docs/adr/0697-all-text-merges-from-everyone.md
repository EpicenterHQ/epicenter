# 0697. All text merges, from everyone

- **Status:** Proposed
- **Date:** 2026-10-30
- **Amends:** [ADR-0695](0695-one-sync-engine-runs-on-every-device-and-a-folder-on-disk-is-its-watched-projection.md) at "an agent's work lands as one commit or not at all" and "refused if `main` moved since it looked, so the agent redoes its work": an agent's batch merges like anyone's save, each file on its own ([ADR-0698](0698-the-file-is-the-unit.md)); nothing is refused because `main` moved, except a `git push`, under Git's own ref rule.
- **Relates:** [ADR-0692](0692-every-write-is-a-live-commit-on-its-parent-taken-through-the-repositorys-server.md) (the live commit, the merge and the door this rule runs on); [ADR-0696](0696-a-page-writes-a-repository-only-through-its-worker-over-collections-its-app-declares.md) (`repo.commit`, a local transaction); [ADR-0698](0698-the-file-is-the-unit.md), which replaced this record's groups, calls, outcomes and messages with the file as the unit, and its repairs.
- **Unbuilt:** a `git push` transport (a receive-pack endpoint into the built receiver). Built: a `git push` taken as a merge, and each file's outcome (ADR-0698).

## Context

ADR-0695 gave writers two rules. A person's save merged into whatever was
current; an agent's batch was refused if `main` had moved since it looked,
and the agent redid its work. The second rule was a writer `mode` on every
live commit (`merge` or `fast-forward`), carried through the commit's id,
the wire, the server, the replica and the tests.

The owner then decided that all text merges, from everyone: only bytes
cannot merge. An agent that redoes its work whenever a person types loses
the race on any busy note, and a refusal tells it nothing a conflict block
would not. Three reviewers agreed on the direction (October 30).

## Decision

**Text merges for every writer.** A live commit carries no mode. Its parent
names the state it was made on; on `main` it becomes `main`, and otherwise
the server merges it where its history and `main`'s meet, the same way for a
person, an app, an agent or a script. A clash is a conflict block, labelled
with its author. Who wrote a commit changes its label and what the session
may do, never how it settles.

**Each file goes on its own, and what cannot go waits or is refused.**
[ADR-0698](0698-the-file-is-the-unit.md) replaced this record's groups,
calls, call outcomes and commit messages: a file goes when it can, alone. A
file that cannot go is `waiting` (the system clears it) or `refused` (only a
person can fix it: an unportable name, a name another file has in other
letters, a note that is not text, a file where a folder is or the reverse),
with its reason, wherever that is found: the device's door, the server or
the folder. Only its writer's next save of the file clears it. Each file
this device sent says how it landed: as sent, with conflict blocks, at a
sibling, or a delete that did not take. What a front end leaves alone (dot
paths, editor droppings, symlinks and other files that are not regular) is
never a save.

**One row per spelling.** Paths equal after NFC and case folding are one
path, spelled as `main` spells it, and a device keeps one row for it. Where
`main` has the path under another spelling than this device's (its own
create crossing someone else's), that row and its work move to `main`'s
spelling before anything is taken: on a catch-up, and on every answer that
lands this device's commit (`applied`, `merged`, or `flushed` long after),
so the work is rebased onto `main`'s text and never sent over it unseen.

**Only bytes compare-and-swap, and a blob write that lost lands beside.** A
blob write lands only where the path still holds the blob its writer saw
(`settlePointer`); one that does not lands at a sibling the server names
from the original stem and its bytes' hash (ADR-0692), and its writer is
told the path. A pointer waits alone for its bytes.

**HTTP's file writes are conditional.** `PUT` and `DELETE /files/<path>`
require `If-Match` (or `If-None-Match: *` to create), checked inside the
server's transaction: the one text write refused because of someone else's
write, as HTTP defines it. `GET /files/<path>` names the commit it read as
`Epicenter-Commit`, so a one-shot client that wants merging posts a commit
on that parent to `POST /commits` instead.

**A `git push` keeps Git's exact ref rule, and its change merges like any
commit.** A push's old value must be Git's `main` (otherwise `main-moved`:
fetch and rebase), and every pushed commit has one parent and passes the
door. That is the only rule `main` moving imposes; Epicenter adds none.
Live edits Git does not hold yet, and a save landing while the push is
checked, are merged, not refused. The pushed change (the diff from the old
value's tree to the pushed tree) becomes one live commit on the live commit
Git's `main` stands for: the flushed place, or the live commit an earlier
push became while it waits to be joined. It merges into live `main` like any
commit: every note merges, and a blob by compare-and-swap, so a stale blob
replace lands beside the live one at a sibling the accepted answer names.
Git's `main` holds the pushed bytes at the path until the join is flushed.

The transaction that lands the live commit journals the move of Git's
`main` from the old value to exactly the pushed commit, and records the
push in the `received` table; then Git's `main` moves by compare-and-swap.
The journal claims only what Git holds: a push applied with nothing live
ahead of Git moves the flushed place to `main`, and a push merged over live
edits leaves it and records a join. The answer is `accepted` (the pushed
commit, Git's head, `merged`, and `published`, false only while a flush is
diverged and Git waits for an operator). A push sent again, after a lost
answer or a crash anywhere after that transaction, is found in `received`
and answered `accepted`, never taken twice. A row a crash left is finished
before a push is checked, and if it moved Git, the push is `main-moved`.

The next flush joins each merged push to the live edits it was merged over:
those edits as a side chain from the push's old value (each commit a state
that existed), then one commit whose first parent is the pushed commit and
whose second is the side chain's tip, with the live merge's tree. `git log
--first-parent` runs through every push, and no commit after a push has a
tree made without it. The join is authored by
`Epicenter <noreply@epicenter.so>` (a default the owner may revisit), with
every writer it merges in as a `Co-authored-by`. A second push from the
first pushed commit, before that flush, passes Git's ref rule and merges
against the first push's live commit. A waiting join is kept by the same
window as all live history; once the window drops it, its pushed commit is
the state and the next commit carries the edits it was merged over. A push
whose base the window dropped flushes first and meets `main-moved`.

A flush writes its objects as one pack with its staging ref, in one
request, so a push queued behind a flush waits a fixed five Git requests,
however many commits the flush writes.

## Consequences

- One rule for every text writer: no mode in the commit, its id, the wire,
  the server or the replica, and no agent reset path.
- An agent never redoes work because a person typed; it may find conflict
  blocks in what it wrote, and repairs them like anyone.
- Another device can see half of a batch (ADR-0698): each file goes when it
  can, and a file that cannot waits or is refused alone. The cross-join
  cycle of groups and messages this record's first form reached cannot
  occur.
- A writer reads each file's state and outcome; a file elsewhere that waits
  or is refused never makes another look failed.
- A `git push` lands beside typing. Measured in the simulation
  (`packages/repository/scripts/push-starvation.ts`, 10 people autosaving
  every 1 to 3 s, 400 ms client round trips): 538 of 538 pushes landed in
  60 simulated minutes, in 1.2 s at the median and 3.2 s at most, where
  refusing live edits Git lacked landed 0 of 3.
- The one refusal typing can still cause is `main-moved`: a scheduled flush
  moved Git between a client's fetch and its push (about once per busy
  flush), or the window dropped Git's base after a quiet spell. Each costs
  one fetch and rebase.
- History is denser: a merged push adds about 2.5 Git commits (the pushed
  commit, its join, and the side commit before it). That is honest
  attribution; an agent pushing every few seconds beside typists makes a
  busy log.
- Every writer's parent may be a commit a merge took in, not only a push's:
  restricting it to the receiver would thread a flag through the live
  commit path, and the merge it allows is the right one.

## Considered alternatives

The alternatives below about groups, calls and messages were weighed while
this record kept them; ADR-0698 removed them.

- **A writer mode, `fast-forward` for agents** (ADR-0695 as written): the
  agent loses every race with typing, and the mode reached every layer.
- **A pointer never joining a group** (phase 8): a note saved with its image
  never waited, but an agent's batch with a new blob, and a blob rename,
  could land half.
- **Splitting a group too large for one request into its files:** each file
  could land alone, so a group was not whole.
- **Leaving a file the folder cannot take out of its call** (the rest lands
  without it, reported as success): a batch half landed whenever the refusal
  was found in the folder rather than at the door.
- **A group as pairs of files saved together, and a message per file and
  level:** a 1,000-file call wrote a million pairs, and moving the message
  bookkeeping across levels and spellings was where most of the folder's
  bugs were; the message is the call's.
- **Unconditional HTTP file writes:** a `PUT` with no precondition over a
  file that moved would replace someone's text without a merge; a merging
  client names its parent through `POST /commits`.
- **Refusing a push while live edits are not in Git (`unflushed`):** a push
  needed a quiet spell of one client round trip; with 10 people typing at
  realistic latency it never landed, and each refusal's flush wrote a Git
  commit, about one a second.
- **Rewriting every live commit onto the pushed commit:** its trees would be
  states that never existed.
- **One merge at the end of a single side chain:** after the first join the
  side chain carries push content without the push as an ancestor, which
  misattributes it.
- **Exporting synchronously inside the push:** removes the waiting join, but
  every push after a merged one then meets `main-moved` unless the client
  fetches first, and `git push` twice in a row is the common agent loop.
- **Letting a push wait only for the ref compare-and-swap, not a flush's
  staging:** a push could then move Git under a staged flush, which would
  have to plan and stage again, and under a pusher every few seconds a long
  flush would never land without a rule giving it priority. Staging as one
  pack keeps one rule (Git's `main` moves one writer at a time) and makes
  the wait a fixed few requests.
- **A join authored by its pusher, or by its range's most frequent writer:**
  the pushed commit is already the pusher's; the join is the live edits
  merged into it, which no one person wrote.
- **Keeping all live history from the flushed place while a join waits:**
  unbounded while flushes are stopped, and a second retention rule beside
  the window.
