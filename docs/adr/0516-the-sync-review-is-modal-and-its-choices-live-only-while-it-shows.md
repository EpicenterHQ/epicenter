# 0516. The sync review is modal and its choices live only while it shows

- **Status:** Proposed
- **Date:** 2026-10-11
- **Relates:** [ADR-0514](0514-folder-sync-resolves-captured-attempts.md) (the attempt and choices), ADR-0528 (actions are mutations; apps own wording)
- **Unbuilt:** the review in Vocab, Capture, Honeycrisp, and Whispering.

## Context

`folder.sync.run()` can return a `SyncAttempt` whose conflicts need a
person's choices (ADR-0514). Every app that syncs needs the same comparison
and the same rule for how long unfinished choices last. `@epicenter/folder`
loads no Svelte, so the shared view cannot live there.

## Decision

**While an attempt waits, the page shows one `SyncReview` from
`@epicenter/svelte/sync-review` in place of everything else, and its only
state is that attempt's `SyncChoices`, kept only while it shows.**

```svelte
{#if syncs.attempt}
	{#key syncs.attempt.id}
		<SyncReview attempt={syncs.attempt} {pending} problems={syncs.problems} onCancel={() => syncs.cancel()} onApply={...} />
	{/key}
{/if}
```

- The review is modal. Nothing else on the page takes input while it shows;
  the open item is locked through the controller's `locked`.
- Cancel discards the attempt and its choices. Nothing is remembered, and no
  run starts while an attempt waits. A new attempt starts with no choices.
- One row per conflict, grouped by path: the part, the local version, the
  incoming version, and the result. `Use this` records `take`. Typing records
  `replace`: a body, a file, or a field whose captured versions are all
  strings is edited as text; any other value is edited as JSON and is not
  applied until it parses. `Leave out` records `remove` where allowed.
- Apply calls `onApply(attempt, choices)` once per press with a snapshot the
  review never changes, and only when every conflict has a choice; there is
  no partial submission. The app
  calls `folder.sync.resolve`. `problems` from `SyncError.InvalidChoices`
  show beside their rows while each row still holds the submitted choice
  object; changing the choice clears its note.
- The sides read "This device" and "Remote" unless the app passes `labels`.
- The folder validates and publishes. The review decodes nothing it sends:
  `take` names a side.

**The attempt lives where the run's result lives.** A sync that needs
choices fails with `SyncError.NeedsChoices({ attempt })`. In Todos the sync
is a TanStack mutation, so the review shows while `sync.error` is
`NeedsChoices`, and `sync.reset()` is Cancel. Apply is a second mutation
that calls `folder.sync.resolve(attempt, choices)`; refused choices return
`InvalidChoices` and keep the attempt, and any other result ends it. The Git
app, which has no query client, keeps the same three facts in runes:
`syncing`, `attempt`, and the refused choices. Both wait for writes in flight
before a run or an Apply and read again afterward. `describeSync` in
`@epicenter/svelte/sync-line` words each result.

## Consequences

- Choices end with the review: Cancel, a reload, or a new attempt starts
  empty, and a person cannot edit files while deciding, so an Apply is not
  made stale by their own edits in the app.
- Apps own the review's labels and any wording beyond `describeSync`; they
  write no comparison, encoding, attempt bookkeeping, or input lock of their
  own.

## Considered alternatives

- **A review that hides and keeps its choices.** Back and "Review sync"
  let the person edit files while an attempt waited, which made their own
  Apply stale and needed a hidden-review state in every app.
- **A session wrapper around a separate grid.** Two components for one
  lifetime.
- **Carry choices to the next attempt.** A stable conflict ID can name a
  different captured value in the next attempt.
- **A larger editor dialog per row.** Text areas grow and scroll; the dialog
  added focus and cancel rules for little gain.

## Verification

`packages/svelte/src/sync-review.mounted.test.ts` mounts the review in jsdom
and covers both versions per conflict, Apply waiting for every choice,
take, text and JSON replacement, removal, a body with no removal, the
choices handed over once and never changed afterwards, Cancel
discarding the attempt, and refused choices beside their rows.
