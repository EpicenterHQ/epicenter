# 0443. Body file codecs return sequence content

- **Status:** Proposed
- **Date:** 2026-09-24
- **Relates:** [ADR-0295](0295-a-database-is-one-yjs-document-and-a-row-holds-its-rich-content.md) (stable body ownership), [ADR-0337](0337-the-folder-is-a-working-copy-and-pull-and-push-are-the-whole-cycle.md) (file push)
- **Unbuilt:** Browser checkout evidence with the new codec contract.

## Context

The old body codec had `encode`, `decode`, and `rewrite`. `decode` built a
detached `Y.Node`, while `rewrite` edited an attached one. Plain text and
Honeycrisp both used the same interpretation for new and existing rows, yet
implemented both mutation paths. Chat was the exception: its body was a map of
message attributes. Chat's finished messages now have their own table rows.

## Decision

A body file codec has two conversions: `encode(body)` returns file text, and
`decode(text)` returns complete, insertion-only sequence content. The artifact
layer rejects root-attribute and top-level positional operations before
mutating the store. For a new row, it
applies the content to a fresh body and creates the row. For an existing row,
it clears and refills the sequence of the same live body inside the push
transaction. The codec cannot edit body-root attributes; a body with such
attributes refuses export.

The codec remains optional. A table without one can exchange an empty body,
and refuses populated body content. An unexpected converter exception becomes
a file-specific import or checkout error. File operations retain their own
`Result` types; codecs have no expected error arm.

## Consequences

The separate `rewrite` method, codec-owned fresh-node construction, and
codec-level `BodyError` disappear. Preview can discard decoded content; push
decodes the approved text again and applies each delta once. Honeycrisp keeps
its own Markdown and ProseMirror schema conversion. The body node keeps its
identity for editors and undo managers, but a file push still replaces its
whole sequence and may overwrite overlapping peer edits. Yjs transactions do
not roll back an unexpected exception during mutation.

## Considered alternatives

A prepared mutation callback would hide each codec's parsed representation,
but would allow arbitrary application code to mutate the live node after other
push writes. Replacing the entire body node would detach editor bindings.
Treating every body as plain text would discard Honeycrisp's structure.

## Verification

Artifact tests cover empty content, edited file bodies, stable body identity,
and rejection of root-attribute or positional-edit deltas. Honeycrisp tests
cover Markdown round trips through the new conversion.
