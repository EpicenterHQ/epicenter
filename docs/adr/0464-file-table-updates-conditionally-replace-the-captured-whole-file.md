# 0464. File table updates conditionally replace the captured whole file

- **Status:** Proposed
- **Date:** 2026-09-30

## Context

A checkbox assigns one field, while a document editor submits complete text
that began from a captured baseline. Requiring both callers to supply an entry
makes an unrelated change since a listing reject a checkbox command. Treating
both as current-content assignments instead lets a stale document erase changes
it never presented.

Tables interpret and prepare Markdown over the same file publisher as raw file
operations. The API must distinguish these intentions without a second storage
mechanism, a target-dependent overload, or retry settings.

## Decision

**Every mutation addresses its row by stem and names its condition.**

This method contract revises two earlier Accepted records without rewriting
them: the `tables.<name>` method row of
[ADR-0471](0471-a-data-folder-handle-exposes-tables-kv-and-files.md)
(`inspect(source)`, `update(stem, change)`, `replace(snapshot, source)`) and
the premise in [ADR-0479](0479-file-mutation-methods-express-publication-intent.md)
that the table API receives a captured entry for edits. Where they differ,
this record describes the table methods. [ADR-0518](0518-a-row-is-read-through-one-pipeline-and-repaired-as-text.md) later
removed `update` and reads every row through one pipeline.

| Method | Table preparation and publication |
| --- | --- |
| `update(stem, { fields?, body? }, options)` | Validate supplied fields, read current text once, check the caller's guard against that read, and patch only requested fields/body. Publish against that read's SHA-256. |
| `replace(stem, text, options)` | Encode the complete supplied text as UTF-8 and publish over the existing row under the caller's guard. The table reads no row. Malformed text is saved. |
| `rename(stem, nextStem, options)` | Read the table directory for the destination, then move the row file under the caller's guard. |
| `delete(stem, options)` | Remove the row file under the caller's guard. The table reads no row. |

The table's preparation is what this table describes. Where a change carries
a condition, the storage publisher reads and hashes the current bytes to
check it; on a desktop folder that happens in the owner process.

`options` is required. `{}` acts on whatever the row holds now.
`{ expectedSha256 }` acts on the bytes the caller reviewed: the change is
`Conflict` unless the current bytes still hash to it. The hash is a condition
on content, not a revision or an identity: two files with the same text have
the same hash, so a guard says "these bytes", never "this version".

The method validates options when called, before anything is awaited, and
reads the guard once. Absent or non-object options, any enumerable own string
key besides `expectedSha256` (a misspelled guard, or a snapshot passed where
options go), and a guard that is not a lowercase SHA-256 are `InvalidPath`.
Symbol, inherited, and non-enumerable keys other than the guard are not
inspected. Only an absent
`expectedSha256` means the current row. A present one that is `undefined`,
which `{ expectedSha256: snapshot?.sha256 }` produces without a snapshot, is
`InvalidPath` before any I/O; presence includes inherited and non-enumerable
properties. The type allows `undefined` in the optional property, so the
runtime enforces this, as it enforces lowercase hex. A caller with an optional
baseline writes `snapshot ? { expectedSha256: snapshot.sha256 } : {}`.

The stem is one literal filename segment under the table's directory, not a
path, and is checked before options. Creation, updates, and rename accept
literal names under the same scoped addressing and actual filesystem rules as
`get`; no portable naming grammar produces content issues. No method other
than `rename` changes the row stem, and none moves other files.

| Missing row | `{}` | Guarded |
| --- | --- | --- |
| `update` | `NotFound` at its read | `Conflict`, `actualSha256: undefined` |
| `replace` | `NotFound` | `Conflict` |
| `rename` | `NotFound` | `NotFound` |
| `delete` | `NotFound` | `NotFound` |

An update or replacement never creates a row. A rename to the stem the row
already has is `InvalidPath` before anything is read, since it would verify
neither the row nor the guard.

`update` captures supplied field values and body before its first wait. It
preserves current unrelated text, including unknown keys, comments, quoting,
ordering, byte-order marks, and untouched newline spans. A field-only update
does not reserialize the body. Validation of a supplied field does not require
unrelated stored fields to conform. Current text must parse
before any structured patch, including a body-only update. Parsing refusal and
unsafe patching of successfully parsed text are distinct preparation failures.
Both refuse without writing. A body assignment replaces the body deliberately;
it does not merge another writer's body edits.

`replace` encodes the supplied text as UTF-8. It neither patches frontmatter nor
requires it to conform to the table schema. This permits complete-text repair.
An editor adapter owns the mapping from its widget to the text being submitted.

**An update's own read is not the caller's guard.** `update` always publishes
against the bytes it read, so a write between its read and publication is a
`Conflict`. That condition covers only the call's own window. A value the
caller derived from bytes it reviewed earlier, such as a title taken from a
body, lands over a newer body under `{}`; only the caller's guard refuses it.
A checkbox whose value does not depend on the rest of the row passes `{}`.

**Each call makes one conditional publication attempt and never retries.**

All four methods use one publisher. Its whole-file SHA-256 check is the
publication condition, even for a single-field assignment. A conflict wrote
nothing. An application can narrow the error by `error.name` and decide
whether to reread, ask for review, or issue a new command.

`Conflict` names a failed publication expectation; `NotFound` names absence.
These names do not assert which writer acted or when. Unknown outcomes remain
`Unconfirmed`.

No operation silently substitutes another baseline after conflict. An unchanged
write still checks its condition. After an uncertain outcome, retain the
intended change for review. A reread observes current state; it cannot prove the
earlier attempt arrived or will not arrive, and bytes that match the attempt do
not acknowledge it, since another writer can produce the same text.
Internally prepared updates do not expose the exact attempted text or hash as
recovery evidence. `Unconfirmed`, partial progress, I/O failures, and thrown
calls never trigger automatic replay. No retry count or transform callback is
exposed.

`create`, `update`, and `replace` return a compact receipt,
`{ stem, path, text, sha256 }`, for the submitted bytes. It is not a later
reread and carries no reading. `rename` and `delete` return `undefined`. Table
updates and replacements check no sibling filenames and infer no attachment
ownership. Creation and rename own destination layout preflight under
[ADR-0477](0477-file-folder-operations-tolerate-repairable-layout-disorder.md).

**The file boundary owns publication for structured and raw saves.**

Browser managed writers compare and publish transactionally. Native checks are
best effort against arbitrary external programs: a hash check followed by rename
is not an operating-system-wide compare-and-swap. The table adds text
preparation and row addressing to the same condition used by
`files.replace(capture, content)`. A snapshot is a file capture, so
`files.replace(snapshot, text)` also saves a row and returns only a capture;
the table method addresses by stem, so it cannot reach a file outside the
table. The pure `inspectRow(table, text)` interprets drafts and receipts.

File-save success remains independent of Git history. Commit and push failures
do not undo a save or change its returned receipt. No editor flush or
pending-ref journal is required solely to complete history.

## Consequences

- A field assignment under `{}` preserves an external title edit saved before
  its read. A toggle computed from an older displayed value can supersede a
  newer same-field edit before this read. A caller that derived its change
  from reviewed bytes passes their hash.
- A guarded save refuses any intervening whole-file change, including one to
  an unrelated field. The application chooses what to do with its draft.
- Concurrent commands can return conflicts even on one handle. The library
  promises no click ordering or completion under continuous contention.
- Text repair can save malformed text and accept its receipt's hash as the new
  baseline. No successful save requires parsing success or a post-save read.
- An editor that keeps its own buffer patches it with `patchRowText` and saves
  it through `replace`; `patchRowText` does not perform table field
  validation. `serializeRow` is for new drafts, not for rewriting an existing
  row, whose unknown keys a reading omits.
- Requiring options makes each call site say which condition it means, and a
  wrapper that omits the argument to its inner call fails to compile. It does
  not force forwarding: a wrapper that passes `{}` of its own drops its
  caller's guard, and neither the type nor the runtime can tell.
- KV preparation and publication follow their own contract; this row decision
  does not change KV commands. The retained canonical editor and its
  unconditional overwrite are gone. An edit session under [ADR-0515](0515-snapshot-saves-serialize-writes-and-retain-only-the-latest-pending-text.md)
  guards each save by the capture its previous save confirmed, so
  disappearance before publication is `Conflict` rather than a recreated row.

## Considered alternatives

- Retry definite conflicts internally: tolerates more races but adds another
  read/publication attempt and a retry-bound decision. Callers receive the error.
- Retry without a bound: an operation can remain pending under continual writes.
- Keep captured-only structured updates: unrelated changes since listing reject
  common field assignments and push fresh-read composition into applications.
- Overload `update` on a stem or entry: makes target shape select the policy and
  retains two structured-update modes.
- Use complete-text overwrite for every save: stale buffers can erase changes
  they never observed. Explicit `files.overwrite` remains available to apps
  deliberately choosing that behavior.
- Optional trailing options, `delete(stem, options?)`, the previous shape: a
  wrapper that never declares the options compiled and dropped the guard. In
  a prototype over the real table, since deleted, that wrapper deleted or
  overwrote an external edit; the required shape stopped compiling there
  (TS2554).
- A whole request, `delete({ stem, expectedSha256? })`, or a target with a
  payload, `replace({ stem, expectedSha256? }, text)`: callers already hold
  `{ stem, sha256 }` records such as snapshots and receipts, and those
  compiled as an unguarded request or target, and deleted the external edit in
  the same prototype. A trailing options type has no such weak-typing hole: a
  snapshot passed as options is refused by its type and, through a cast, at
  runtime.
- Make a present `undefined` guard unrepresentable in types. The union
  `{ expectedSha256: string } | { expectedSha256?: undefined }` still accepts
  a `string | undefined` value, and an empty-record member gives the property
  a misleading read type. Turning on `exactOptionalPropertyTypes` would change
  every package. A sentinel mode value adds a second spelling of `{}`. The
  runtime refusal covers the case without either.

## Implementation

[Table commands](../../packages/folder/src/table.ts) share the file publisher
and return compact receipts; [regression coverage](../../packages/folder/src/table.test.ts)
includes the guard-forwarding, derived-update, present-`undefined`, and
missing-row cases above. [Capture drafts](../../apps/capture/src/lib/draft.svelte.ts)
consume receipts directly. Recreation prepares its receipt without a reread,
then explicitly observes the path once to preserve immediate conflict review.
A publication receipt and a later observation answer different questions.
