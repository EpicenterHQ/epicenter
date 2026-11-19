# 0253. Schema lenses interpret stored JSON on read, and writes admit storage-valid facts

- **Status:** Accepted
- **Date:** 2026-08-19
  open ADRs before merge.
- **Amends:** [ADR-0120](0120-fields-validate-present-values-and-table-lenses-own-presence.md)
  at write admission. Withdrawn: declaration-level value and known-field
  rejection on ordinary scalar writes. Read conformance, field presence, and
  explicit repair remain.
- **Amends:** [ADR-0251](0251-one-transaction-coordinator-backs-direct-operations-and-explicit-compositions.md)
  at write result channels. Schema failures are not write errors; structural
  and lifecycle outcomes remain.
- **Amends:** [ADR-0252](0252-kv-is-one-structured-value-with-whole-value-reads-and-conformance-results.md)
  at KV updates. `kv.update` writes supplied storage-valid values and returns
  no schema Result; `kv.get` remains the whole-value conformance boundary.
- **Relates:** [ADR-0164](0164-scalar-facts-converge-independently-epicenter-refuses-distributed-transactions.md),
  ADR-0217,
  and [ADR-0238](0238-the-live-document-is-the-truth-while-open-and-persistence-is-a-visible-debt.md).

## Context

The canonical Yjs document must preserve facts across application releases,
devices, and schema lenses. Validating a value against the current declaration
before every write makes one release's interpretation a gate on shared data and
makes a one-field repair depend on every other field already conforming.

TypeScript still gives an application compile-time guidance through its
declared database shape. Runtime writes, imports, older releases, and remote
replicas can carry values the current release does not understand. That is a
read interpretation problem, not a reason to reject the fact at the write
boundary.

## Decision

**Scalar writes admit storage-valid JSON facts without enforcing the current
schema lens. Reads validate stored values against the current declaration and
report nonconformance. Write APIs return only structural or lifecycle outcomes;
they do not return schema-validation errors.**

KV writes are direct key-level mutations:

```ts
db.kv.update({ theme: 'dark' });
```

The operation writes the supplied fields and returns `void`. `kv.get()` reads
the whole reserved root and returns its conformance Result. An application can
compose a usable view without authoring defaults back into the document:

```ts
const { data, error } = db.kv.get();
const settings = data ?? {
	...db.kv.defaults,
	...error?.conforming,
};
```

Table writes follow the same schema boundary. `create` mints the structural row
and returns its typed write view. `update` writes supplied fields and keeps only
the structural `RowAbsent` outcome when its addressed row does not exist.
Unknown fields and values are preserved as storage-valid JSON and are surfaced
or ignored by the current read lens according to its declaration. A future
release may understand data this release does not.

Storage-validity and lifecycle remain enforced. Values must be representable by
the JSON/Yjs storage format; reserved internal attributes, row structure,
document addresses, and retirement rules remain owned by their respective
boundaries. A disposed store throws, and persistence reports durability
separately. None of these are schema-conformance Results.

Independent document content already follows this rule: the document manager
does not interpret application roots or content. Its operations can still fail
for hydration, retirement, or lifecycle reasons.

## Consequences

- A malformed or future value can enter the local document and synchronize. A
  read reports what the current lens understands, what it does not, and what
  conforming subset remains available.
- A single invalid field never blocks a correction to another field:

  ```ts
  db.kv.update({ fontSize: 14 });
  ```

- Ordinary writes no longer return `Nonconforming` or `UnknownField` errors.
  `RowAbsent`, deletion presence, document retirement, and other structural
  outcomes remain meaningful.
- Compile-time safety remains the normal application experience, but it is
  guidance at the write boundary rather than a runtime storage invariant.
- `get` and `list` are the places where applications recover through defaults,
  conforming subsets, and explicit repairs.
- The authority and sync transport remain schema-blind. They carry bytes and
  do not acquire a schema-validation role.

## Considered alternatives

- **Validate every supplied value before writing:** refused because it makes a
  release-local lens a shared write gate and blocks independent repair.
- **Validate the complete object after every patch:** refused because an
  invalid unrelated field would prevent a valid partial correction and because
  read-modify-write changes the per-key merge boundary.
- **Make writes completely unbounded:** refused because JSON/Yjs
  representability, reserved storage attributes, and lifecycle structure are
  still real invariants.
- **Return schema Results from writes:** refused because a schema mismatch is a
  fact about the later interpretation of accepted data, not a failure to accept
  the write.
