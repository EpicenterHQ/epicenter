# Yjs document design

Use the installed `@y/y@14.0.0-rc.26` source and declarations when a conflict
or API detail affects the design. This release exports one shared type,
`Y.Node`, with attributes and a sequence. Yjs 13 map/text/array APIs do not
apply to Epicenter.

## The store owns the row layout

```text
Y.Doc
`- tables:<name>
   `- rowId: Y.Node
      |- attributes: JSON metadata
      `- sequence[0]: stable body Y.Node
         |- body-owned attributes
         `- collaborative content
```

Creation integrates the row and its body in one transaction. Reads require
exactly one node child and never repair missing structure. Updates change
attributes without replacing the child. Deletion removes the row attribute
and its whole subtree. A feature asks `table.body(id)` for the live node and
binds the editor there; `table.get(id)` returns values.

Index zero locates the child, but does not define its CRDT identity. Never
remove and recreate the body to implement a rewrite. The editor, undo manager,
and watchers retain that node. Parent metadata stays outside editor schema
normalization. Arbitrary attributes inside the body remain the codec/editor’s
responsibility.

## Choose the conflict unit deliberately

An attribute set with `node.setAttr(key, value)` replaces that entire value.
Concurrent writes to different keys merge; concurrent writes to the same key
select one winner. Client IDs participate in deterministic conflict ordering;
this is not wall-clock last-write-wins. A JSON array or object remains one
value, even if two devices edit different members.

Use rows for independently editable records. A collaborative body may own
nested nodes when its concrete codec needs them. Do not expose extra nested
metadata shapes to work around the table’s whole-value field contract.

A counter implemented as read-plus-one loses concurrent increments. A
per-writer count avoids that conflict only if each writer owns its key and
increments it serially. Client IDs are replica-session identifiers, not user
identities. Do not use them for durable identity or authorization.

User ordering belongs in an explicit sortable value. Deleting and reinserting
an integrated node is not a move and cannot preserve its identity. Use the
product’s ordering policy rather than inventing a numeric midpoint algorithm
that cannot represent repeated insertion indefinitely.

## Root identity and nested identity differ

`doc.get(name)` creates a root on miss and converges by name. A nested node
converges by its struct identity. Two devices independently creating nodes at
the same row key can discard one subtree. The store prevents that by minting
row IDs and creating the body with the row, never lazily on read.

`create(fields, body?)` accepts a fresh unintegrated body. A body already
attached to a document is refused. Custom raw-node code can still reach
`parent` and `doc`; the table API is not a security boundary.

## Persistence is not just serialization

Transmit and replay V2 updates through the store’s sync boundary. A state
vector does not encode deletion knowledge. Re-encoding a live document is not
proof that all tombstone overhead vanished. The store’s acknowledged-history
fold replays updates into a fresh GC-enabled document; owed updates use
`mergeUpdatesV2` so they remain safe to resend. Preserve that distinction.

See the [data contract](../../../../packages/app/src/data/README.md) and
[ADR-0431](../../../../docs/adr/0431-rows-return-values-and-own-a-separate-body.md)
for the current API and its row/body decision.
