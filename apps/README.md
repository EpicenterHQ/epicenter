# Apps

Each app under `apps/` owns a product surface. An app that stores Epicenter data
contributes an inert Lens and an application facade; it does not own a database,
sync partition, identity scope, or migration runtime.

```txt
pure Lens definition
        |
environment-owned record Epicenter
        |
typed Lens binding
        |
application facade
        |
UI or host commands
```

## Data composition

A Lens defines one durable namespace and its release-local table or values
interpretations. Keep it pure JSON and free of storage, auth, network, and UI
objects. The environment opens the record Epicenter, attaches synchronization
when appropriate, and binds the Lens. The application facade turns those
borrowed typed collections into product operations.

Honeycrisp and Whispering show the maintained layout:

```txt
apps/<app>/src/lib/
|-- data/                 Lens definitions and shared data types
|-- application.ts       ready, UI-free product facade
|-- application-platform.ts or #platform/*
|                         environment-owned replica composition
`-- state/ or queries/    UI reactivity over the ready facade
```

An app package may export its Lens when another trusted host composes it.
Epicenter desktop binds Chat, Honeycrisp, and Whispering to one Bun-owned record
replica. Browser builds open one origin-owned replica. Neither case creates an
app-specific database.

## Boundaries

- Use `defineLens`, `defineTable`, and `defineValues` from
  `@epicenter/data/record`.
- Put independently changing bounded properties in scalar fields. Use a
  row-owned Yjs document for collaborative interior state and the record-owned
  blob slot for large immutable bytes.
- Treat Lens schemas as release-local interpretation. Preserve unknown or
  nonconforming records; do not turn a Lens into a migration chain.
- Keep storage, attachment, credentials, document connections, and disposal in
  the environment adapter.
- Acquire one ready application facade at the mounted root. Components consume
  that facade; they do not open replicas.
- Put reusable product operations in the application layer, not in a generic
  action registry or daemon mount.

Do not restore the deleted Workspace API, root-Yjs authority, per-app sync
routes, or compatibility aliases. Historical specs and ADRs may still use the
old noun when describing the subsystem that was removed.

## Adding a Lens-backed app

1. Define one qualified namespace and its collections under `src/lib/data/`.
2. Add an environment opener for each supported runtime. Local boot must not
   depend on authentication; sign-in adds whole-replica sync.
3. Build one abortable application acquisition boundary that binds the Lens,
   completes initial reads, and owns disposal.
4. Mount the ready facade through typed context or host composition.
5. If another package must compose the Lens, export one direct `./lens` entry.
   Do not export a storage or lifecycle object.
6. Test the Lens through a real record owner, then typecheck every supported
   runtime condition.
