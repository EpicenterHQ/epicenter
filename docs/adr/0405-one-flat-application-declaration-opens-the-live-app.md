# 0405. One flat application declaration opens the live App

- **Status:** Accepted
- **Date:** 2026-09-18
- **Amends:** [ADR-0391](0391-the-build-selects-every-implementation-and-an-application-declares-only-its-id-and-data.md) at the declaration shape only: `defineApp({ id, title, kv, tables })` replaces `defineApplication({ appId, definition })`. Implementation selection remains a separate decision.
- **Implemented:** `defineApp` in `packages/app/src/index.ts`. Honeycrisp, Vocab, Whispering, and Local Mail export the same inert declaration to their opening paths and schema consumers. Runtime selection remains outside this change.

## Context

Application authors currently call `defineData({ id, title, kv, tables })`,
then pass that result to `defineApplication({ appId, definition })`. The store
applications repeat their identity across the two declarations. Tests and
artifact import/export also use the data declaration without opening an App.

## Decision

**An application declares its identity and schema once through `defineApp`.**

The target API is:

```ts
const notes = defineApp({
  id: 'com.example.notes',
  title: 'Notes',
  kv: {
    microphoneId: field.string(),
    preferredLanguage: field.string(),
  },
  tables: {
    notes: defineTable({ title: field.string(), body: field.string() }),
  },
});

const app = notes.open(alice);
```

The single `id` names both the application and its data definition. `title`,
`kv`, and `tables` retain their data-definition meanings and type inference.
Application authors supply no nested `definition` and no second `appId`.

`defineApp` is the application-level composition of a data declaration and an
opener. The lower-level data package keeps `defineData` for consumers that
declare or open data without constructing an application.

**The returned declaration remains inspectable and inert; opening creates the live handle.**

```ts
notes.id;                 // Application and data identity
notes.title;              // Declared title
notes.kv.microphoneId;    // Field declaration
notes.tables.notes;       // Table declaration, no rows or mutations

const app = notes.open(alice);
// After the readiness gate:
app.account.personal.tables.notes.create({ title: 'Meeting', body: '' });
```

The declaration exposes its schema at the root. Importing or constructing it
opens no storage, starts no sync, and captures no Account. Schema consumers,
including in-memory tests and artifact import/export, accept this same
declaration. They need no duplicate schema object and no `.definition` wrapper.
The live handle has no root `tables` or `kv`: a caller selects `device`,
`account.personal`, or an available account library as its destination.

The opening overloads retain the supplied Account's presence as decided in
[ADR-0404](0404-the-opened-account-owns-application-local-storage.md). App
readiness, signals, borrowed store handles, and close ownership do not change.
The lower-level data package keeps its standalone schema API for consumers
that open data without constructing an application.

## Consequences

Application declarations lose a factory call, one wrapper property, and a
repeated identifier. Schema tools and live application code share one typed
source of truth. The application-level API no longer supports giving an app
and its declared data different identities; lower-level data operations remain
available where those identities differ intentionally.

Implementation must preserve schema inference and inert imports while moving
callers to `defineApp`. Existing durable identities must be preserved during
that migration. This decision does not authorize renaming stored data.

## Considered alternatives

- **Keep two declarations.** Their independent identities are useful to
  lower-level data operations, but add no choice for the store applications.
- **Return only `.open()` and hide the schema.** Tests and import/export would
  need another way to recover the declaration they already supplied.
- **Expose `.definition` beside `.open()`.** Adds a wrapper where the declared
  root keys can remain directly inspectable.
- **Put live `tables` at the App root.** Hides which store receives the write.
