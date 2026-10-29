# 0697. All text merges, from everyone

- **Status:** Proposed
- **Date:** 2026-10-30
- **Amends:** [ADR-0695](0695-one-sync-engine-runs-on-every-device-and-a-folder-on-disk-is-its-watched-projection.md) at "an agent's work lands as one commit or not at all" and "refused if `main` moved since it looked, so the agent redoes its work": an agent's batch merges like anyone's save, and lands in one commit or is held whole; nothing is refused because `main` moved, except a `git push`, under Git's own ref rule.
- **Relates:** [ADR-0692](0692-every-write-is-a-live-commit-on-its-parent-taken-through-the-repositorys-server.md) (the live commit, the merge and the door this rule runs on); [ADR-0696](0696-a-page-writes-a-repository-only-through-its-worker-over-collections-its-app-declares.md) (`repo.commit`, the call whose group lands whole).
- **Unbuilt:** `epicenter commit` (its stored message and its report of the conflict blocks it wrote); a `git push` transport; the push measurement and the push-as-merge prototype that decide whether `unflushed` goes.

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

**A call's group lands whole.** What one call saved (`repo.commit`, a
replica's `writeAll`, later `epicenter commit`) is one group. The device
sends a group in one commit or not at all: it waits while any file of it is
held or owed its bytes, and a file of it the door or the server refuses
holds the rest with it. A group too large for one request is held whole,
never split; its writer saves less. A later save of a file in a held group
joins that group. Separate calls are separate groups: a person attaching an
image and then naming it in a note makes two, so the note never waits on the
upload.

**Only bytes compare-and-swap.** A blob write lands only where the path
still holds the blob its writer saw (`settlePointer`); one that does not is
held with why, and so is its group. A pointer joins the group of the call
that saved it, and that group waits for its bytes.

**HTTP's file writes are conditional.** `PUT` and `DELETE /files/<path>`
require `If-Match` (or `If-None-Match: *` to create), checked inside the
server's transaction: the one text write refused because of someone else's
write, as HTTP defines it. `GET /files/<path>` names the commit it read as
`Epicenter-Commit`, so a one-shot client that wants merging posts a commit
on that parent to `POST /commits` instead.

**A `git push` keeps Git's ref rule, and Epicenter's `unflushed` limitation
for now.** A push's old value must be Git's `main` (otherwise `main-moved`:
fetch and rebase), and every pushed commit has one parent and passes the
door. Epicenter adds one rule Git does not have: while live edits are not in
Git yet, a push is refused as `unflushed` (a flush starts, and the client
fetches and retries), and so is a push during whose check a live commit
landed. On a repository someone is typing in, a push can wait for a quiet
moment. Agents that work beside people write through the engine. Before a
receive-pack transport is built, two things decide whether `unflushed` goes:
a measurement of push starvation under one and ten people autosaving, and a
prototype of a push taken as a merge (a recorded Git base per push, the
right flushed place, how the live side reaches Git, the answer after the ref
moved, crash recovery, continuous typing, and a second push from the first
pushed commit).

## Consequences

- One rule for every text writer: no mode in the commit, its id, the wire,
  the server or the replica, and no agent reset path.
- An agent never redoes work because a person typed; it may find conflict
  blocks in what it wrote, and repairs them like anyone.
- A batch's files are never seen half-landed by anyone else. The cost is
  waiting: a batch with a large upload waits for it, and one refused file
  holds its whole group until its writer saves again.
- A group too large for one request needs its writer to save less, since
  saving one of its files alone still waits for the rest.
- A `git push` is starved on a busy repository until the measurement and the
  prototype decide otherwise.

## Considered alternatives

- **A writer mode, `fast-forward` for agents** (ADR-0695 as written): the
  agent loses every race with typing, and the mode reached every layer.
- **A pointer never joining a group** (phase 8): a note saved with its image
  never waited, but an agent's batch with a new blob, and a blob rename,
  could land half.
- **Splitting a group too large for one request into its files:** each file
  could land alone, so a group was not whole.
- **Unconditional HTTP file writes:** a `PUT` with no precondition over a
  file that moved would replace someone's text without a merge; a merging
  client names its parent through `POST /commits`.
- **A push taken as a merge now:** the flusher would need a second history
  shape, and journaling the pushed tree as covering live edits would claim
  Git holds what it does not; deferred to the prototype.
