# 0169. Row references are non-enforcing table interpretations

- **Status:** Proposed
- **Date:** 2026-07-20

## Context

Applications, Epicenter Home, and agents benefit from knowing that one
stored row field intends to name a row in another table. The current
`field.reference()` encodes that relationship inside a scalar JSON Schema, but
a field schema should describe which values may be stored. Whether another row
currently exists, how to navigate to it, and whether absence deserves a
diagnostic depend on the substrate interpreting the table.

## Decision

A row reference is non-enforcing table interpretation metadata. It says that a
declared string field intends to contain the row ID of a named target table. It
never guarantees that the target exists, remains present, is unique, arrives in
the same synchronization step, or participates in ownership, cascading
deletion, a transaction, or referential integrity.

The shared field vocabulary describes scalar values only. The clean-break
destination has no `field.reference()` kind and no reference marker inside a
field's JSON Schema. A future table contract may declare
references separately from `fields`, but this ADR does not freeze the JSON or
TypeScript authoring shape.

One stored reference value names at most one target row. The reverse direction
is naturally zero to many because any number of source rows may store the same
target row ID. The platform exposes no cardinality mode, inverse declaration,
uniqueness rule, reference array, foreign key, or generic relationship record.
Applications that need independently convergent many-to-many membership use
ordinary relationship rows or own an application-specific representation.

The same rule applies when several binary assets belong conceptually to one
parent. Each asset is an ordinary row with its own zero-or-one blob slot and may
store or receive a non-enforcing parent reference. Deleting the parent never
cascades. Reference changes and asset-row deletion are independent operations,
so valid orphan asset rows may temporarily or permanently remain until the
application or person deletes them.

Epicenter references may name a table in another namespace. Namespace
proximity grants no ownership or lifecycle semantics. Missing or unavailable
target Lenses do not invalidate canonical data; raw addresses and stored IDs
remain inspectable.

Consumers may use reference metadata according to their honest observation
boundary:

- Epicenter Home may provide navigation, local resolution status, SQL join
  assistance, and agent context over the currently visible Epicenter.
- Typed application code may use branded IDs and direct table point reads. This
  decision does not introduce an ORM traversal API or promise that a target
  Lens is statically available.

## Transition

Matter, which read the `x-ref` marker for its grid, integrity panel, and CLI
check, is deleted (ADR-0534). The reference implementation wave chooses the
table-level contract and then deletes `field.reference()`, `x-ref`, and the
shared reference field kind in the same dependency-ordered change. The legacy
marker earns no compatibility reader after that clean break.

## Consequences

- Scalar validation stays independent from cross-row interpretation.
- Forward resolution is always nullable, and applications continue to handle
  absent targets explicitly.
- Home and agents may explain useful joins without turning those joins into
  synchronization or deletion invariants.
- The shared reference kind disappears when the table-level contract lands,
  not in a separate behavior-deleting change.
- The eventual table metadata shape and typed reference-navigation ergonomics
  remain open implementation and product decisions.

## Considered alternatives

- **Keep references as a shared field kind.** Rejected because scalar value
  validation cannot own target resolution or integrity semantics across
  substrates.
- **Enforce references as foreign keys.** Rejected because independently
  converging rows can legitimately expose a missing target and Epicenter
  refuses distributed cross-row invariants.
- **Declare one-to-one, one-to-many, and many-to-many cardinalities.** Rejected
  because one stored target ID already determines the useful forward and
  reverse query multiplicities; stronger cardinality requires enforcement the
  platform does not provide.
