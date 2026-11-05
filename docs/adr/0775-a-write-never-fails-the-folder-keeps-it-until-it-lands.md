# 0775. A write never fails: the folder keeps it until it lands

- **Status:** Accepted (2026-11-05)
- **Date:** 2026-11-05
- **Amends:** [ADR-0774](0774-one-write-makes-it-so-and-settles-a-change-the-way-sync-does.md) at "A write fails only as `Invalid` or `Unavailable`": a write never fails; [ADR-0767](0767-an-async-lifecycle-is-modeled-as-synchronous-state-actions-wait-on-their-own.md) at the folder's states and at an action answering the open's error: the folder's state is its lifecycle and whether its store is available, and a write waits through both.
- **Relates:** [ADR-0768](0768-retry-belongs-to-a-failure-and-editing-app-ts-reloads-the-page.md) (retry belongs to a failure), [ADR-0746](0746-the-web-is-online-offline-needs-an-installed-app.md) (the web is online), [ADR-0608](0608-apps-never-talk-to-each-other-they-share-paths.md) (a contract states what a reader expects and owns nothing).
- **Unbuilt:** all of it: `set`, `delete` and `edit`'s saves answering `Promise<void>`; the folder's ordered queue of waiting writes and its retry; `folder.unavailable()`, a temporary open failure retried on its own, and each collection's `error()` deleted; writing an off-contract value; throwing on a name that would leave its collection; deleting the conversation's `unsaved`, `saveError`, `save()` and `MessageSaveError`, Whispering's recording held in the page with "Save again", and Capture's failed-write states; Whispering's `AGENTS.md` lines on an outbox and on a recording kept in the page.

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
states.

One cause also showed three ways. A store out of reach while the folder
opened was `failed`, with a Retry button; while it was open, each
collection's `error()` said a listing failed; and a write answered
`Unavailable`. A person asks two things, and they are separate: whether
their data is here, and whether it is reaching its store now.

## Decision

**A folder answers three questions, one read each.**

```ts
folder.state();        // is my data here: opening, open, failed (with retry), or closed
folder.unavailable();  // is it reaching its store now: an Unavailable saying why, or null
folder.saving();       // is anything of mine still out: landing, or waiting for the store
```

```ts
type FolderState =
	| { status: 'opening' }
	| { status: 'open' }
	| { status: 'failed'; error: OpenFolderError; retry(): Promise<void> }
	| { status: 'closed' };
```

`unavailable()` says the store cannot be reached or written now, and why.
While opening, the folder keeps trying; while open, what it shows may be
old and writes wait. Either way it clears on its own, and it is null once
the folder failed or closed. Availability does not depend on the
lifecycle, so it is not part of the state: `<WhenOpen>` reads `state()`, and
an indicator of waiting changes reads `unavailable()` and `saving()`.
`failed` is only what waiting will not fix, such as no storage in a private
window or access taken away, and its `retry()` is for after the person has
acted. A collection's `error()` goes: it was the same fact as
`unavailable()`. Its `loading()` stays until listings are made per folder.

**A write is a promise the folder keeps.** `set`, `delete`, and an editor's
save answer once the change has landed, and never fail. While a write
cannot land, the folder holds it, with every later write, in the order they
were made, and tries again; `saving()` stays true and `unavailable()` says
why. A write made while the folder is opening waits for it to open.
Resending is safe because a `set` makes the same result however often it
lands. When the folder moves to `failed` or `closed`, the writes waiting
then are not made.

**A value that does not fit the contract is written.** The note shows in
`invalid()`, as one another program wrote would, and can be repaired there.
A note's whole text typed in an editor is saved as typed: the merge reads a
header by its fences, not by parsing it, so a key whose value does not
parse still merges as a key, and a text with no closing fence is all body.
A field change to a note that does not read keeps the note and adds the
change as a conflict block, by `settle`'s rule for another note at the path.

**A name is the app's; only one that would leave its collection throws.** A
placeholder is part of a file name (ADR-0776). A name that is empty, holds a
`/`, is `..`, or holds a character a file system refuses would write outside
the collection or nowhere, so it throws before anything is written; an app
turns a person's title into a file name first.

**Errors are the folder's state.** An app reads what is wrong from
`state()`. No write answers a `Result`.

## Consequences

- Every app's own "not saved yet" machinery goes, with the error branch at
  each write's call site and each collection's `error()`.
- A temporary failure to open no longer asks the person to retry.
- Waiting writes live in the page's memory. Closing the page while they
  wait loses them; the leave guard asks first, as it does today.
- Code that awaits a write waits until it lands, which keeps writes in
  order (a recording's audio before its note).
- A write after the folder is disposed throws: the page is gone.
- An app can write a note other apps cannot read; it shows as invalid until
  it is repaired.
