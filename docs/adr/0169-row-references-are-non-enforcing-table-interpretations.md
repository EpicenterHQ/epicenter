# 0169. Row references are non-enforcing table interpretations

- **Status:** Proposed
- **Date:** 2026-07-20
- **Relates:** [ADR-0026](0026-matter-vault-sqlite-is-a-projection-never-a-verdict-source.md)

## Context

Applications, Epicenter Home, agents, and Matter benefit from knowing that one
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
field's JSON Schema. A future Lens or Matter table contract may declare
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

- Matter may assess one loaded vault and report resolved, dangling, or missing
  targets. These are diagnostics over current disk state, not write
  enforcement.
- Epicenter Home may provide navigation, local resolution status, SQL join
  assistance, and agent context over the currently visible Epicenter.
- Typed application code may use branded IDs and direct table point reads. This
  decision does not introduce an ORM traversal API or promise that a target
  Lens is statically available.

If Matter gains namespaces, one Matter vault contains all of them. When that
vault is versioned with Git, one repository contains the complete vault rather
than assigning one repository to each namespace. The vault and repository are
the assessment, query, sharing, and privacy boundary; a namespace remains only
an address coordinate inside it. Data that needs a different public or private
boundary belongs in another vault and repository, and generic references do not
cross that boundary.

The exact Matter namespace layout remains open. A Matter vault currently
supplies the enclosing address scope for its tables, while an Epicenter row
address includes an explicit namespace coordinate.

## Transition

Epicenter code and new Lens JSON do not adopt `field.reference()`. Matter may
continue using the current `x-ref` field marker temporarily because its grid,
integrity panel, CLI check, and the Vault's artifact-to-page diagnostics already
depend on that behavior.

The reference implementation wave first replaces Matter's marker with the
chosen table-level contract, proves the existing Matter verdicts against that
contract, and then deletes `field.reference()`, `x-ref`, and the shared
reference field kind in the same dependency-ordered change. The legacy marker
earns no compatibility reader after that clean break.

## Consequences

- Scalar validation stays independent from cross-row interpretation.
- Matter and Epicenter can share the concept of a reference without pretending
  they can make the same integrity promise.
- Forward resolution is always nullable, and applications continue to handle
  absent targets explicitly.
- Home and agents may explain useful joins without turning those joins into
  synchronization or deletion invariants.
- Matter retains its current reference diagnostics during the transition, while
  Epicenter gains no new dependency on the legacy field kind.
- The shared reference kind disappears when Matter moves to the table-level
  contract, not in a separate behavior-deleting change.
- The eventual table metadata shape, typed reference-navigation ergonomics,
  and Matter namespace model remain open implementation and product decisions.

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
- **Use one Git repository per Matter namespace.** Rejected because it turns an
  address coordinate into installation, privacy, and lifecycle, makes a vault
  incomplete after one clone, and requires cross-repository discovery before
  assessment or SQL can be complete.
- **Never add namespaces to Matter.** Deferred because namespaces may still
  earn their place as address grouping inside one complete vault. Symmetry
  alone does not justify the layout.
