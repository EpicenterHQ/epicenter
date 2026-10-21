# 0664. Folder close drains admitted work through one owner

- **Status:** Accepted
- **Date:** 2026-10-21
- **Amends:** ADR-0574, ADR-0656, and ADR-0657 at action admission and orderly teardown. ADR-0662's FileEdit and MarkdownContent contract remains.

## Context

The Svelte context admitted app actions through `context.run`, stopped editor
input through `folder.stopEditing`, waited for those actions, and only then
called `folder.close`. Folder separately tracked storage saves and protected
file actions. One-path and multi-path actions had two exclusive APIs and a
special bound-file map to survive storage closure. The context could report
closing while Folder reported open.

## Decision

Folder owns action admission as well as edits and storage. Its one `run(paths,
action)` entry admits a whole action. Empty paths admit lifetime only; nonempty
paths also reserve local input and competing reservations, await already-queued
saves, and attempt held input before running the callback. Failed input prevents
the callback and remains recoverable. Reservations are not storage transactions
or locks on other programs or raw storage calls.

The callback receives FolderWork: ordinary file and typed-table storage
operations plus child `run`, without editors, listeners, settle, or close. It is
branded so a root Folder cannot accidentally stand in for admitted work. Its
access expires when the callback returns or throws. Calls and children already
started finish before the action releases its reservations or reports completion.
Child actions may be admitted during close; overlapping reservations refuse
rather than queue, including overlaps with an ancestor.

Close synchronously refuses fresh input, new root actions and root storage
calls. Already-admitted storage access survives. Available held input is sent
without waiting for unrelated network work; newly released paths are attempted
after actions drain. A failed revision is not retried twice by the same settle.
FileEdit.save attempts or joins only its own path during close, avoiding a cycle
with an action that called it. After close completes it does nothing. Failed
input remains readable. Repeated close calls share one completion.

All saves and admitted actions use the handle's single lifetime registry.
Svelte owns query and window cleanup, and its closing state reads Folder status.
Remove stopEditing, context.run and its action registry, both public exclusive
methods, ExclusiveFile and the bound-file map. Ordinary editing remains FileEdit;
MarkdownContent remains a snapshot without independent identity or lifecycle.

## Consequences

Actions must use the storage capability received by their callback for
continuations. Captured root storage calls refuse during close. Captured root
settle or close must not be awaited inside an admitted action because they wait
for it; the work capability intentionally omits both. Callbacks that never finish
can still hold close open, as app actions could before.

Workflow updates use witnessed storage changes, rather than a second editor
lifecycle. Honeycrisp's logical-folder deletion keeps its partial-progress and
final-membership checks; Whispering keeps confirmed-file deletion and rename
witnesses; Capture promotes a draft once; Messages keeps the durable sending
marker and uncertain-send recovery across its request.

## Alternatives

Leaving all root storage open while any action drains would let unrelated late
callers enter after close. Scoped access preserves one truthful admission
boundary. General raw-write locking would add mutation checks and new refusal
semantics beyond the existing local edit fence; it is not required here.

## Built

`packages/folder/src/handle.ts`, `edit-owner.ts` and `folder.ts`, with migrations
in the Svelte context, Honeycrisp, Whispering, Capture, Messages and saved views.
Regression coverage includes late child admission, expiry, early return and
throw while calls drain, reentrant close, failed-input recovery, and close during
real multi-step app actions.

## Amendment, 2026-10-21: one action reserves one upfront set

`FolderWork.run` is removed. The child-action clauses above (FolderWork's child
`run`, children finishing before release, child admission during close, and
overlaps with an ancestor) and the late-child regression test are history.
`folder.run(paths, action)` is admission only: an action's reservation is
declared before it starts and cannot grow. `[]` still admits lifetime only, as
Messages' draft opening uses it. Reservations still protect local input and
competing reservations; they do not limit which paths the callback's storage
calls reach, do not cover raw storage calls or outside programs, and are not
storage transactions. Root storage still refuses as soon as close starts; an
admitted callback's storage access still survives close until the action ends,
calls already started still finish before release, and close still drains late
scoped storage calls.

Child scopes were correct: Honeycrisp's folder deletion reserved each member
in its own child, then read it fresh and checked its folder before writing from
that witness. The single scope keeps that protection with less machinery: one
fixed set and one lifetime per attempt. Deletion reserves the notes the page
lists in the folder, every note with unsaved typing, and the folder's file;
still rechecks each member fresh before writing; and, because the set cannot
grow, refuses before any move when its fresh read finds a member it did not
reserve. Writing such a member from that unreserved read could undo a
concurrent move, so a workflow that depends on reserved input refuses rather
than writes it. The page then holds that read, so the next attempt includes
it. Messages reserves its durable draft path when a send is
called, with its Web Lock inside that action. Capture, Whispering and Epicenter
already used one level.
