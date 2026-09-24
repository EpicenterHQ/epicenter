# 0431. Rows return values and own a separate body

- **Status:** Proposed
- **Date:** 2026-09-23
- **Amends:** [ADR-0309](0309-a-field-holds-a-value-or-a-node-and-the-retired-words-fail-the-build.md) at the row API and stored node layout. Value fields and collaborative nodes keep their distinct editing behavior.
- **Amends:** [ADR-0295](0295-a-database-is-one-yjs-document-and-a-row-holds-its-rich-content.md) only at the nested row layout: the body moves from an attribute to the sole sequence child; the one-document decision stands.

## Context

A page has structured properties and collaborative writing. Both belong to one
identity and serialize together as frontmatter plus a file body. Returning the
live node alongside value snapshots made ordinary row reads unsuitable for
serialization and required consumers to remove the special `content` property.

A single combined Yjs node could remove the nested body slot, but then editor
normalization, codecs, subscriptions, and undo would each need to distinguish
row attributes from body operations. Keeping the nested node enforces that
boundary across the rich-text and plain-text callers. Chat now stores finished
messages as separate rows instead of body attributes.

## Decision

The implemented CRDT vocabulary is `@y/y@14.0.0-rc.26` and `Y.Node`.
Honeycrisp uses `@y/prosemirror@2.0.0-12` and binds the body child.


`defineTable({ fields, body? })` separates field schemas from the optional
`BodyCodec`. A row is a Yjs node whose attributes hold value fields and whose
sole sequence child is its stable body node. The store creates both nodes in
one transaction and never exposes an operation to replace the child. Readers
require exactly one child of type `Y.Node`.

The body occupies no attribute key. `body`, `content`, and `!`-prefixed names
follow the ordinary field and unknown-value rules. Structural `id` remains
reserved. A field named `body` appears in frontmatter; the separate body node
serializes below the fence.

`get`, `rows`, and `create` return value snapshots. `body(id)` returns the live
body independently of metadata conformance and never creates one on read.
`create(fields, body?)` may receive a fresh body as a separate argument; the
store integrates it with the new row. Updates cannot replace that node.
Deleting the row removes its fields and body together.

The file layer preserves all stored value fields as frontmatter and renders
the body through its codec. Its faithful read returns `{ id, fields, body }`,
keeping JSON fields separate from the live node through serialization.
File-body rewrites replace the sequence inside the existing node so open
editors retain their binding. The reactive adapter tracks body existence even
when metadata fails validation.

Omitting a codec still creates an empty body. A populated body without a codec
refuses export; nonempty file text without a codec refuses import.

## Consequences

The mixed snapshot/live row contract and codec-as-field type machinery disappear.
The body-name reservation and its declaration, write, and frontmatter checks
disappear. Body integrations retain their own attribute namespace. Checkout
orders operations by kind as well as field name, so editing a field named
`body` cannot be confused with editing the document body.

The move from an attribute-held body to a sequence child is an intentional clean break. Migration
and fallback readers are out of scope. The frontmatter-plus-body file layout
remains unchanged.

## Considered alternatives

A separate document collection would require list projections and field editing
without removing those needs from pages. Parallel field and body maps could
preserve one-to-one ownership, but add coordination without providing independent
loading inside the same Yjs document. A combined row node remains an experiment;
it must demonstrate an application-level simplification beyond removing one node.

A named body attribute would require reserving a user field name. A separate
fields container would avoid that reservation but add a node per row and put
field and body edits at the same depth. The sole-child layout avoids both costs.
Its positional invariant belongs to the store: callers edit the child returned
by `body(id)`, while the row container remains internal.

## Verification

Tests cover a field named `body` alongside the editor body, artifact import and
checkout push/pull of both, replica convergence, stable node identity, separate
field/body notifications, malformed metadata, and deletion. Honeycrisp's codec
and editor tests cover rich-text serialization and the artifact layer's
in-place sequence replacement.

The browser regression at `apps/honeycrisp/evidence/editor/browser.ts` mounts
both real editor components and checks typing, undo/redo, parent metadata,
bound rewrites, peer updates, IndexedDB reopen, and deletion. A raw body node
can reach its parent and document; this API is not a security sandbox.
