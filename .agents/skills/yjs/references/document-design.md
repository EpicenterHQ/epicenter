# Yjs document design

Use the installed `@y/y` 14 source and declarations when a conflict or API
detail affects the design. This release exports one shared type, `Y.Type`,
which is map, list, and rich text at once. Yjs 13 map/text/array classes do not
apply to Epicenter.

The store owns the layout: a database is one document whose table roots hold
each row as a nested type, and a row's rich content is a nested type on the row
(ADR-0295, ADR-0296). Features read and write through the table API and bind
editors to the live type the store hands out; they do not construct or repair
that structure themselves.

## Choose the conflict unit deliberately

An attribute set with `setAttr(key, value)` replaces that entire value.
Concurrent writes to different keys merge; concurrent writes to the same key
select one winner. A JSON array or object remains one value, even if two
devices edit different members. Use rows for independently editable records,
and do not expose extra nested shapes to work around a whole-value field.

Client IDs participate in deterministic conflict ordering; this is not
wall-clock last-write-wins. From dmonad (Yjs creator):

> "The 'winner' is decided by `ydoc.clientID` of the document (which is a generated number). The higher clientID wins."
>
> Source: [GitHub issue #520](https://github.com/yjs/yjs/issues/520)

A later edit can therefore lose. Design around that fact rather than assuming
the most recent write survives.

A counter implemented as read-plus-one loses concurrent increments. A
per-writer count avoids that conflict only if each writer owns its key and
increments it serially. Client IDs are replica-session identifiers, not user
identities; do not use them for durable identity or authorization.

User ordering belongs in an explicit sortable value. Deleting and reinserting
an integrated type is not a move and cannot preserve its identity. Prefer
string fractional keys, such as those from
[fractional-indexing](https://github.com/rocicorp/fractional-indexing), over a
numeric midpoint, which runs out of precision under repeated insertion.

## Root identity and nested identity differ

`doc.get(name)` creates a root on miss and converges by name. A nested type
converges by its struct identity. Two devices independently creating types at
the same row key can discard one subtree. The store prevents that by minting
row IDs and allocating a row's structure when the row is created, never lazily
on read.

## Persistence is not just serialization

Transmit and replay V2 updates through the store's sync boundary. A state
vector does not encode deletion knowledge. Re-encoding a live document is not
proof that all tombstone overhead vanished. The store's acknowledged-history
fold replays updates into a fresh GC-enabled document, while owed updates stay
individual so they can still be offered and acknowledged by id. Preserve that
distinction.

See [ADR-0295](../../../../docs/adr/0295-a-database-is-one-yjs-document-and-a-row-holds-its-rich-content.md)
and [ADR-0296](../../../../docs/adr/0296-rich-content-is-a-declared-field-and-a-table-owns-its-file-codec.md)
for the current decisions.
