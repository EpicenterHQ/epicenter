# 0229. A lens names the store it opens, and opening is one call

- **Status:** Accepted
- **Date:** 2026-08-09
  this branch. Reconcile at merge time (`docs/adr/README.md`).
- **Amended by:** ADR-0233:
  in a browser the lens still names the application, and the caller also names
  which durable document to open and whose it is, so the derived location
  becomes `epicenter/<namespace>/device` or
  `epicenter/<namespace>/account/<principal id>` and the open claim is that
  same address.
- **Amended by:** [ADR-0240](0240-an-application-declares-one-workspace-and-an-opened-runtime-holds-exactly-one-definition.md):
  withdrawn are "`bind` stays reachable on an application" and "`lens` keeps
  its name", both of which stood on ADR-0160's multi-interpretation model.
  The declaration is `defineWorkspace`, an opened runtime holds exactly one
  definition, and there is no `bind`. Everything else here stands.
- **Amended by:** [ADR-0237](0237-nonconformance-is-a-reads-only-error-and-a-disposed-store-throws.md):
  `bind`'s Result error arm narrows to `LensParseError`; a storage refusal
  while binding throws `StoreUnusableError`, which the openers convert to an
  open-time failure.
- **Amends:** [ADR-0213](0213-a-lens-is-arktype-json-and-an-application-queries-only-its-own-projection.md)
  at two rows of its naming table and at `bind`. Withdrawn: that one opener per
  runtime must stand in front of a separate `bind` because "the three opens
  share no I/O profile", and that `bind` returns a `Result` because a lens may
  arrive from an installed application folder. Both supports were removed by
  ADR-0227 rather than reasoned away here. What survives unchanged is everything
  the record decided about the lens itself: arktype JSON, nullable-never-optional,
  one type through every door, validation that never gates storage, plain rows
  (a draft of this record said frozen; rows were never frozen, each read
  constructs a fresh plain object so mutation cannot reach the store, and
  per-row freezing is refused because it would be the store's only row-rate
  freeze), and every verb on the table taking the id.
- **Amends:** [ADR-0204](0204-an-app-is-one-reverse-domain-identifier-that-names-every-place-it-exists.md)
  by completing it. Its rule was that one identifier names every place an app
  exists; the store's location was the last place still carrying a second name.
- **Relates:** ADR-0160
  (a lens is partial and non-authoritative, which is why the word survives),
  ADR-0215
  (one document per application),
  [ADR-0225](0225-a-store-authority-is-one-durable-object-per-principal-and-application-and-being-signed-in-is-the-sharing-model.md)
  (the authority is already addressed by namespace),
  [ADR-0227](0227-one-runtime-a-desktop-spa-in-a-webview-over-a-client-owned-store.md)
  (which removed both supports this record retires).

## Context

Opening a store takes two calls and carries two names for one thing. The single
production call site in the repository, and there is exactly one, is:

```ts
// apps/honeycrisp/src/lib/dependencies.ts
const { data, error } = await openBrowserStore({ name: 'honeycrisp' });
// apps/honeycrisp/src/lib/application.ts
const bound = store.bind(honeycrispLens);   // namespace: 'so.epicenter.honeycrisp'
```

`'honeycrisp'` locates the store and `'so.epicenter.honeycrisp'` names the data.
Nothing relates them, so binding Mail's lens to Honeycrisp's store typechecks
and runs. That is the exact defect ADR-0204 exists to remove, surviving in the
one place it could still hide.

ADR-0213 gave three reasons for the split. Two stopped being true last week, and
the third was never a reason for a separate call.

**One opener per runtime, because "the three opens share no I/O profile."**
There are no longer three. ADR-0227 refused hosted web and the extension, and
ADR-0226 left the host owning no application data, which emptied the Bun path:
`openBunStore` has no caller outside this package's own tests, and its own
JSDoc says so. What remains is one live opener and one test opener.

**`bind` returns a `Result` because "a lens may arrive as data from an installed
application folder."** ADR-0227 refused the installed-app plane and deleted
`packages/app`. Every lens is now a TypeScript literal checked by `defineLens`'s
`ValidateLens<L>`, so a lens that does not typecheck does not ship.

**A store holds one application.** This was never an argument for two calls; it
is an invariant the store already asserts in prose and cannot enforce. From
`store.ts`, on `query`:

> It reaches one application's tables because a store holds one application, not
> because anything here scopes by namespace: the statement runs against the whole
> file. That is a bound on WHAT A STORE IS, and it is the only bound there is.

A namespace is already a lifecycle scope everywhere else: one document
(ADR-0215), one file (ADR-0214), one Durable Object (ADR-0225), one folder
(ADR-0208). The opener was the only place it was still a decoration.

## Decision

**A lens names the store it opens. Opening is one call, and its argument is the
lens.**

```ts
// publishable, pure JSON, no runtime dependency (ADR-0168)
export const inbox = defineLens({
  namespace: 'so.epicenter.mail',
  title: 'Inbox',
  tables: { messages: { subject: 'string', unread: 'boolean' } },
});

import { open } from '@epicenter/data/browser';
const { data: mail } = await open(inbox);

mail.tables.messages.create({ subject: 'hi', unread: true });
mail.query`SELECT * FROM messages WHERE unread`;
```

### The namespace determines the location

`name` and `directory` are deleted as parameters. A browser store's IndexedDB
database and a Bun store's directory are derived from `lens.namespace`, so the
mismatch above is not something a caller must avoid; it is something a caller
cannot express.

### The runtime stays in the subpath, never in the identifier

`open` is the name at `@epicenter/data/browser` and at `@epicenter/data/bun`.
The subpath already says which adapter, and `openBrowserStore` said it twice.
One runtime survives ADR-0227 anyway, so the word in the identifier names a
distinction the product no longer makes.

### Opening one namespace twice in one process is an error

`open` refuses a namespace it already holds open, with
`StoreError.AlreadyOpen`. Two opens would be two `Y.Doc`s of one document that
cannot see each other's writes, converging through storage under last-writer-wins:
work disappears, converged, with no error and nothing to retry. That is the
failure class ADR-0216 deleted the chosen-id door to make unreachable, and this
is the same move.

The registry that makes the refusal possible is legitimate under ADR-0203 rather
than a platform forming: one file and one document with two claimants is
genuinely contended, and contention earns a lifecycle. It is process-local, it
holds namespaces rather than handles, and disposing a store releases its entry.

### The application is the lens's view, and the file sits under `store`

```ts
mail.tables.messages.create({ … });   // what an application does
mail.kv.get();
mail.query`SELECT …`;
await mail[Symbol.asyncDispose]();

mail.store.pressure();                // what the runtime does
mail.store.sync;
mail.store.applyRemote(bytes);
```

The split is by who calls it, and it is measured rather than asserted. Merging
the two put **13 own keys on the application where 4 are used**; grouping makes
it 5, and the nine CRDT and transport verbs stay reachable one hop away.

It also deleted machinery. The merge was
`Object.freeze({ ...store, get sync() {…}, ...view })`: a forwarded getter,
because spread copies a getter's value, plus **three `as unknown as` casts**,
because matching `LensView<TLens>` structurally through a spread intersection
exceeded TypeScript's depth limit. Grouping is `{ ...view, store }`, the getter
is unnecessary, and the casts are gone; two call sites pass explicit type
arguments instead.

**What it did NOT buy, stated because it was the hypothesis going in.**
TypeScript cost is unchanged: 63,770 instantiations before and 63,951 after,
check time 1.15 s and 1.08 s, which is noise. Composing the object fell from
350 ns to 50 ns and from 265 B to below the measurement floor, and that is 0.2%
of a 136 us open, so nothing about this is a performance decision.

### The application mirrors the lens, so nothing is reserved

A lens declares `namespace`, `title`, `tables` and `kv`. The application is the
same shape seen from the other side, so `tables` is a container rather than a
spread.

**Corrected before merge.** A first version of this record spread the tables at
the top level and put the file's verbs under a reserved `$store` key, citing
Jazz's move to `$jazz` in 0.18.0. That was treating the symptom. Flattening had
already cost this API three collisions in its first month: a draft that named
the bound value `notes` beside a table called `notes`, `query` reserved as a
table name (ADR-0213), and `$store` invented to hold nine more. Table names come
from users, so under a flat shape every verb the store ever grows is a breaking
change to their namespace. Nesting the tables ends that permanently, and it
retires ADR-0213's reservation of `query` rather than working around it. The
`kv` reservation survives on its own footing: KV projects as a SQL relation of
that name, which no amount of nesting on the handle changes.

### `bind` stays reachable on an application

Opening binds the lens that named the store, so nothing has to call `bind`. It
is not hidden, because a namespace may carry more than one interpretation and
none of them is canonical (ADR-0160): taking a second view of a file this
process already holds is how that is done, and it needs one document rather than
a second open the namespace claim would refuse.

What is deleted is `bindUnknown`, which existed so a lens could arrive as data
from an installed application folder. ADR-0227 refused that plane.

### `lens` keeps its name

The word says the view is partial and non-authoritative, which ADR-0160 states
outright: multiple lenses may interpret one namespace and none is canonical.
That is the fact a reader most needs to hold once a second application reads the
same rows. Renaming it `database` or `schema` would imply ownership of rows
another application also writes, and ADR-0168 already refuses `schema`.

### What is deleted

`openBunStore`, `openBrowserStore`, the `name` and `directory` parameters,
`Store.bindUnknown`, the untyped `Bound` it returned, and the root barrel's
re-export of `./sync`, which no consumer ever reached the transport through.
`openMemoryStore` becomes `openMemory(lens)`, so one entry point has one shape.

## Consequences

- **An application's whole boot is one await per namespace**, with no second
  call, no second name, and no composition object:

  ```ts
  const { data: mail }  = await open(inbox);
  const { data: notes } = await open(backlinks);
  ```

- **The multi-namespace model from ADR-0160 becomes expressible rather than
  theoretical.** One namespace is one store, so an application that reads a
  second application's data opens a second store, and the two are as separate on
  disk, in memory, and at the authority as they already were.
- **Relensing costs a reopen.** Tests that rebind a second lens to a live store
  to prove the projection rebuilds now close and reopen. That is what a release
  upgrade already does, so the test shape follows the product shape rather than
  the other way round.
- **`bindUnknown` goes, and with it the last consumer of `parseLens` on the hot
  path.** A lens arriving as unknown data was the installed-app case; ADR-0227
  refused it. `parseLens` stays exported for the inspector, which reads lenses it
  did not author.
- **The application is 5 own keys instead of 13**, and the nine CRDT and
  transport verbs are one hop away under `store` rather than mixed in with the
  four an application uses. It also removed a forwarded `sync` getter and three
  `as unknown as` casts.
- **`query` stops being a reserved table name**, which is what the 242 call
  sites that gained `.tables.` bought. `kv` stays reserved, and for a different
  reason that this record does not remove: KV projects as a one-row SQL relation
  literally named `kv`, so the collision is in the projection rather than on the
  handle. Proved by creating, listing and querying a table called `query`.
- **What this forecloses:** a second name for a store's location, an opener that
  takes a path, a lens bound to a store it does not name, two OPENS of one
  namespace in one process, `lens.open()` as a method, and any future store verb
  that would reserve a table name.

## Considered alternatives

- **Keep `bind`, so two lenses can share one document.** The strongest
  objection, and it fails on the facts: the store already holds one application
  by its own contract, so two lenses on one store share a flat table-root space
  and collide silently if both declare `notes`. Every production call site binds
  exactly once. The case `bind` protected is served by one wider lens.
- **Spread the tables and reserve a key for the file verbs.** Shipped for an hour
  and corrected above. It reserves names in a namespace that belongs to users,
  and it makes every future verb a breaking change.
- **`lens.open()` as a method.** Rejected outright. A lens must survive
  `JSON.stringify` and `JSON.parse` and be authorable as a hand-written
  `lens.json` (ADR-0168), and a method on it breaks that in the one way the
  record cannot tolerate.
- **Keep `openBrowserStore` and derive only the name from the lens.** Rejected:
  it fixes the two-names defect and keeps the second call, which is the half of
  the problem with no argument left behind it.
- **Rename `lens` to `database`.** Considered because the handle really is one.
  Rejected on ADR-0160's grounds: the word is what tells a reader their
  interpretation is partial and that another application may hold a different one
  over the same rows.
