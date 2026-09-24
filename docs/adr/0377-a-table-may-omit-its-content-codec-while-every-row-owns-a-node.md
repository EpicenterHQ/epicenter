# 0377. A table may omit its content codec while every row owns a node

- **Status:** Proposed
- **Date:** 2026-09-08
- **Unbuilt:** The declaration and Local Mail consumer are implemented; complete desktop saved-query workflow verification remains.

## Context

Saved queries need `name` and `sql` fields. Previously, `defineTable` required
an explicit content codec even though row creation independently provisions a
content node. `plainText()` works with an empty node, but also declares that
arbitrary artifact body text has meaning for this table.

The artifact implementation already distinguishes storage from interpretation.
Without a codec, an empty node can export as fields alone. A populated sequence
or attributes prevent export, and a nonempty incoming body prevents import.

## Decision

`content` is optional in a table declaration. Omission means no content codec
was declared; it does not install `plainText()` or another default codec.
Every row still owns the reserved content node, created atomically with the row.
The row type continues to expose that node unconditionally.

The artifact boundary exports a codec-less empty node without a body and
refuses populated sequences or attributes. Import refuses a nonempty body
without a codec. These refusals preserve data whose interpretation the current
declaration cannot state. Omission does not prohibit writing to the live node.

An explicitly supplied codec must remain valid at both type and runtime
boundaries. Ordinary field inference, reserved keys, and declaration branding
remain intact. Tables that intentionally use text declare `plainText()`;
structured content keeps its own codec.

## Consequences

Saved queries can declare only `name` and `sql`. No storage migration, extra
row kind, conditional content node, or public empty-content helper is needed.
Generated artifact instructions must explain that fields-only files cannot
accept added body text.

Existing explicit codecs are not removed wholesale. An application with no body
editor can still have existing imported bodies, so removing its codec changes
what it can export and import. Such changes require evidence from that table's
callers and artifacts.

## Considered alternatives

- Require `plainText()` for every fields-only table: assigns unused body semantics.
- Default omitted content to `plainText()`: assumes a representation that can
  lose structure when a node carries attributes.
- Add `emptyContent()`: duplicates the artifact boundary's existing emptiness
  checks; a codec that merely returns empty text would discard data.
- Omit the stored node: changes row structure and future content ownership for
  a declaration-level convenience.
