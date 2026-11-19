# 0216. A name-addressed location is the only safe place for a write two devices both make

- **Status:** Accepted
- **Date:** 2026-08-07
  this branch. Reconcile at merge time (`docs/adr/README.md`).
- **Relates:** ADR-0215
  (the document model this rule governs),
  [ADR-0213](0213-a-lens-is-arktype-json-and-an-application-queries-only-its-own-projection.md)
  (the lens and the application surface).
- **Amends:** [ADR-0206](0206-a-rows-id-comes-from-whoever-knows-it-and-one-relation-holds-every-fact.md)
  at the deletion of singleton values. Withdrawn: that "a singleton is a row
  whose id you chose", and with it the claim that a chosen address needs no
  vocabulary of its own. A `kv` section returns. What survives, and is the
  reason this record is narrow, is everything else 0206 decided: one relation
  holds every fact, there is no dotted grammar, and no second read shape exists
  for ordinary rows.
- **Amends:** [ADR-0213](0213-a-lens-is-arktype-json-and-an-application-queries-only-its-own-projection.md)
  at two verbs. Withdrawn: `ensure(id, fields)` and the chosen-id door
  `create(rowId, fields)`. A row is created at a minted id, always.

## Context

ADR-0206 deleted the `kv` concept after measuring exactly one declared value
across every shipped lens, and folded singletons into rows: "a singleton is a
row whose id you chose". ADR-0213 restated that and added `ensure(id, fields)`
as the get-or-create verb a singleton needs.

**That was sound for the store it was written against, and the store changed
underneath it.** A cell store holds flat facts, and a chosen address merges per
key like any other. ADR-0215's store holds nested containers, and a chosen
address is a container two devices can each create.

The measurement was also the wrong measurement. It counted how many singletons
exist. What matters is that **every device writes its settings on the boot
path**, so the unsafe case is not rare, it is universal.

## Decision

**A location addressed by its name is safe for two devices to create. A location
addressed by the struct that created it is not. Anything two devices will both
write goes at a name-addressed location.**

### Why the two differ

`Doc.get(key)` is `map.setIfUndefined(this.share, key, ...)`, so a root's
identity *is* its name and two devices minting it independently converge on one
root. `new Y.Type()` produces a struct whose identity is the operation that
created it, so two devices produce two types, and map last-writer-wins keeps one
and discards the other **along with everything inside it**.

Measured, two devices offline, each writing one setting:

| | result |
| --- | --- |
| both write to the same **root** | `{ theme: 'dark', fontSize: 22 }`, both survive |
| both mint a **nested container** at one key | `{ theme: 'dark' }`, one write gone |
| one container exists, then both edit it | `{ title, date }`, per-field merge is correct |

The third line is what makes minted ids safe and is why this is not an argument
against nesting: created once, a container merges per field exactly as intended.
Pinned in `evidence/invariants.test.ts`.

### KV lives at a reserved root

```ts
export const lens = defineLens({
  namespace: 'so.epicenter.honeycrisp',
  kv: { theme: "'light'|'dark' = 'light'", fontSize: 'number = 14' },
  tables: { notes: { title: 'string', tags: 'string[]', date: 'string|null' } },
});

const { data, error } = db.kv.get();
const settings = data ?? { ...db.kv.defaults, ...error?.conforming };
db.kv.update({ theme: 'dark' });
```

The root is `!kv`, which is unreachable from a lens by construction rather than
by rule, because a table name must start with a letter. `kv` is reserved as a
table name so the projection can mount it as a one-row relation.

**It costs almost no new machinery, which is the sign it is in the right place.**
KV is a table with exactly one row and no id, so the compiled table serves it
unchanged: same conformance, same declared defaults, same per-supplied-value
write validation, same recovery composition minus the id. There is no `create`
because it always exists, no `delete` because there is nothing to remove, and
`update` rather than `set` because only the keys handed in are touched.

### A row is created at a minted id, always

`ensure(id, fields)` and `create(rowId, fields)` are withdrawn. Both wrote a
container at an address the caller chose, and `ensure` was the dangerous one
because every device calls it at boot.

A 24-character minted id (ADR-0206) makes a collision unreachable rather than
unlikely, so the failure above stops being something callers must avoid and
becomes something they cannot express. Verified before removing: no production
code in the repository used a chosen row id or `ensure`.

**An application that wants to name something names it in `kv`.** That is the
whole replacement, and it is a smaller surface than the two verbs it removes.

### What this does not fix

The container holding a row's document is still struct-addressed, so two devices
creating the same row concurrently would lose one document subtree. Minted ids
make that unreachable through the API. It is recorded because a future path that
reintroduces chosen ids, most plausibly a mirror keyed by a provider id, would
reintroduce it. A mirror rebuilds from its provider and never merges (ADR-0192),
so the contributed plane should stay minted-only.

### Why not flatten instead

Flattening rows to `<rowId>.<field>` attributes on the table root is also
name-addressed, and it is correct under concurrent creation without needing
minted ids. Measured at 20,000 rows against nesting:

| | encoded | dead row | encode |
| --- | --- | --- | --- |
| nested | 2,637 KB | 37 B | 14.9 ms |
| flat | 4,238 KB | 158 B | 15.5 ms |

61% larger and 4.3x more per dead row, because the row id is repeated in every
attribute key and the V2 encoder does not deduplicate it. It also cannot hold a
document without nesting something anyway. Removing the chosen-id door buys the
same correctness at nesting's size and deletion cost, rather than trading one
for the other.

Lifting rows to roots is refused for ADR-0212's reason, which reproduces:
`Item.write` calls `findRootTypeKey`, a linear scan of `doc.share`, so encoding
goes quadratic at 14.8, 344 and 5,346 ms for 1,000, 5,000 and 20,000 rows. A
root also cannot be removed, so every deletion makes that scan permanently
worse.

## Consequences

- **Two verbs are gone and nothing replaced them**, because the thing they were
  for moved to a section that already existed in an earlier design.
- **ADR-0206's reasoning is worth keeping as a caution.** It measured the right
  thing about the store it had and the wrong thing about the problem: counting
  declared values answers "is this worth the concept", not "is this safe". When
  a store's merge semantics change, decisions that turned on those semantics
  have to be re-read even when they look unrelated.
- **The rule generalises past this case.** Anything Epicenter later wants two
  devices to create independently, at any level, belongs at a name-addressed
  location or must be created exactly once. That is a shorter rule than a list
  of verbs to be careful with.
- **`kv` is per application**, living in that application's one document, so it
  is not a shared namespace and two applications cannot collide in it.
