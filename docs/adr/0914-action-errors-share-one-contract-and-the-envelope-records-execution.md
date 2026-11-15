# 0914. Action errors share one contract and the envelope records execution

- **Status:** Accepted (2026-11-15)
- **Date:** 2026-11-15
- **Relates:** [ADR-0850](0850-an-action-changes-files-and-whoever-knows-the-intent-commits-them.md), [ADR-0869](0869-a-body-is-changed-by-quoting-the-passage-it-replaces.md), [ADR-0873](0873-the-command-is-epicenter-cli-and-it-supplies-epicenter-app-to-every-app.md), [ADR-0879](0879-an-action-may-yield-values-while-it-runs-and-only-its-return-is-the-answer.md).

## Context

Collections constructed `FileError.Changed` and `FileError.Missing`. The UI
client constructed four more variants and exposed their union as `ActionError`.
Only file errors passed through the decoder unchanged. This made the decoder's
choice look like a necessary distinction between error families.

The distinction also encouraged callers to infer effects from names. Vocab
inferred that `Threw` meant its message was saved, although its action can throw
before saving and a response can be lost after saving. A nested operation can
fail without establishing what the enclosing action wrote.

## Decision

Producers and clients use one `ActionError` contract, defined in
`packages/app/src/errors.ts`. Its six variants are `Changed`, `Missing`,
`Threw`, `Refused`, `Unreachable`, and `Stopped`. Payload schemas supply factory
input types and validate received fields. An enumerable
`namespace: 'epicenter/action-error'` marker makes participation explicit; it
prevents accidental namesake recognition, not deliberate forgery.

The client returns every valid marked error unchanged. Other tagged throws
remain inside `Threw.thrown`, with their safe JSON fields intact. Names describe
failure reasons: `Unreachable` can identify a dependency, `Stopped` can report
work stopped elsewhere, and `Refused` does not mean the enclosing action wrote
nothing.

Keep the existing `returned` / `threw` / `error` wire envelope and the runner's
safe serialization. CLI exit codes come from that envelope, independently of
the shared error name. The wire preserves pre-run `CliError` details; the
browser adapter retains its message and optional next step as `Refused`.

A UI recognizes its own Stop using that request's captured controller. It
rereads the record to determine what persisted and retains unsent text while
the outcome is uncertain. It interprets `Missing` or `Changed` using the
operation's subject, not the name alone. An error never establishes rollback
or permission to repeat an arbitrary action.

## Consequences

- One factory/type family and validator replace the separate file and client
  definitions and the file-only promotion rule.
- Actual app imports and assumptions about stopping, availability and saving
  migrate together with the platform export.
- Already-open old clients can still recognize new marked file errors because
  the envelope and file fields stay intact. Custom throw nesting stays intact.
  New clients against old unmarked servers are not supported by a second
  recognition path.
- Unknown-value serialization, wire validation, callback isolation, stream
  cancellation and commit/lock ownership remain necessary.
- Conversation recovery can reread a record repeatedly after a failure even
  when the server answered. The public Result preserves the reason, not whether
  the outer call answered. Keep this conservative recovery cost rather than
  reserve some shared variants for transport or add call-phase metadata.

## Considered alternatives

- **Keep the file-only decoder rule.** It preserves an arbitrary subset and
  does not establish general provenance: a dependency's file error can already
  refer to a different record.
- **Reserve variants by producing phase.** This preserves a stronger meaning
  than callers need. Phase belongs to the envelope; persistence comes from the
  record.
- **Normalize a new canonical wire error in the runner.** This changes custom
  throw nesting or adds compatibility representations for existing clients.
  The retained answer adapter is smaller.
- **Declare error schemas on every action.** This could type app-specific
  failures, but adds an author obligation unrelated to unifying the platform's
  existing failures.
