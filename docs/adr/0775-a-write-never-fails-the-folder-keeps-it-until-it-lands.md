# 0775. A write never fails: the folder keeps it until it lands

- **Status:** Accepted (2026-11-05)
- **Date:** 2026-11-05
- **Amends:** [ADR-0774](0774-one-write-makes-it-so-and-settles-a-change-the-way-sync-does.md) at "A write fails only as `Invalid` or `Unavailable`": a write never fails; [ADR-0767](0767-an-async-lifecycle-is-modeled-as-synchronous-state-actions-wait-on-their-own.md) at the folder's `open` state and at an action answering the open's error: an open folder says why its writes wait, and a write waits through a failed open.
- **Relates:** [ADR-0746](0746-the-web-is-online-offline-needs-an-installed-app.md) (the web is online), [ADR-0771](0771-plain-files-let-epicenter-refuse-renames-attachment-conflict-copies-and-a-second-store.md) (plain files), [ADR-0608](0608-apps-never-talk-to-each-other-they-share-paths.md) (a contract states what a reader expects and owns nothing).
- **Unbuilt:** all of it: `set`, `delete` and `edit`'s saves answering `Promise<void>`; the folder's ordered queue of waiting writes and its retry; `waiting` in the open state; throwing on a path the placeholders cannot form; writing an off-contract value; deleting the conversation's `unsaved`, `saveError`, `save()` and `MessageSaveError`, Whispering's recording held in the page with "Save again", and Capture's failed-write states; Whispering's `AGENTS.md` lines on an outbox and on a recording kept in the page.

## Context

Under ADR-0774 a write is `set`: make it so, which is the same change sent
once or twice. Two failures were left. `Invalid` refused a value that did
not fit the contract, though any other program may write such a note and
the folder already shows one in `invalid()`; and `note-repair` held a
person's broken text in memory instead of saving it. `Unavailable` said a
write could not land: the network gone, the disk full, the account signed
out, or the folder never opened. Each app answered it with machinery of its
own: the conversation's `unsaved`, `saveError` and `save()`, Whispering's
recording kept in the page with "Save again", Capture's failed-write
states. That is the write side of what `reactive` collapsed for reads: one
concern owned once per app.

## Decision

**A write is a promise the folder keeps.** `set`, `delete`, and an editor's
save answer once the change has landed, and never fail. While a write
cannot land, the folder holds it, with every later write, in the order they
were made, and tries again; `saving()` stays true, and the open state says
why:

```ts
await folder.todos.set({ id }, { done: true });   // answers when it landed
folder.saving();                                  // true while a write waits or lands
folder.state();                                   // { status: 'open', waiting: Unavailable | null }
```

A write made before the folder opened, or while it has failed to open,
waits for it to open. Resending is safe because a `set` makes the same
result however often it lands.

**A loss that does not pass is the folder's state, not a write's.** A
revoked team, a signed-out account, or a store that will not open again
moves the folder to `failed` or `closed`, which `<WhenOpen>` already shows;
the writes waiting then are not made.

**A value that does not fit the contract is written.** The note shows in
`invalid()`, as one another program wrote would, and can be repaired there.
A note's whole text typed in an editor is saved as typed. A field change to
a note that does not read keeps the note and adds the change as a conflict
block, by `settle`'s rule for another note at the path. Placeholders that
cannot form a path in the collection (an empty id, a `/`, a `..`) are a bug
in the caller and throw, so nothing is written outside a collection.

**Errors are the folder's lifecycle.** An app reads what is wrong from
`state()`: `opening`, `open` with why writes wait, `failed` with `retry`, or
`closed`. No write answers a `Result`.

## Consequences

- Every app's own "not saved yet" machinery goes, and the error branch at
  each write's call site with it.
- Waiting writes live in the page's memory. Closing the page while they
  wait loses them; the leave guard asks first, as it does today.
- Code that awaits a write waits until it lands, which keeps writes in
  order (a recording's audio before its note).
- A write after the folder is disposed throws: the page is gone.
- An app can write a note other apps cannot read; it shows as invalid
  until it is repaired.
