# 0240. An application declares one workspace, and an opened runtime holds exactly one definition

- **Status:** Accepted
- **Date:** 2026-08-13
- **Amended by:** [ADR-0243](0243-a-workspaces-id-is-its-applications-reverse-domain-identifier.md)
  at the public name: the declaration exposes its reverse-domain application
  identifier as `id`.
  this branch. Reconcile at merge time (`docs/adr/README.md`).
- **Supersedes:** ADR-0160:
  its address grammar and its "no independent Lens ID" stand, but its central
  claim, that several release-local Lenses may interpret one namespace and
  none is canonical, described the shared one-Epicenter namespace model that
  ADR-0226/0227 deleted. An application now owns its namespace, and its
  declaration is complete and canonical for that application.
- **Amends:** [ADR-0229](0229-a-lens-names-the-store-it-opens-and-opening-is-one-call.md):
  withdrawn are its "`bind` stays reachable on an application" and "`lens`
  keeps its name" sections, both of which stood on ADR-0160. Everything else
  stands: the declaration names the store it opens, opening is one call, the
  namespace is the location, two opens of one namespace are refused, and the
  application surface is `{ tables, kv, query, store }`.
- **Amends:** [ADR-0213](0213-a-lens-is-arktype-json-and-an-application-queries-only-its-own-projection.md)
  at the noun only. Everything it decided about the declaration itself
  survives verbatim: arktype expressions in JSON, byte-identical round-trips,
  nullable-never-optional, one type through every door, validation that never
  gates storage. The artifact is now called a workspace declaration, authored
  with `defineWorkspace`, and parsed with `parseWorkspace`.
- **Amends:** ADR-0210:
  the admission artifact is `workspace.json`, not `lens.json`. Same shape,
  same rules, same admission gate; staged candidates are re-published by
  re-running their build script.
- **Relates:** ADR-0215
  (one document per application),
  ADR-0232
  (a page lifetime is one generation, which is the lifecycle this record's
  invariant rides on),
  [ADR-0238](0238-the-live-document-is-the-truth-while-open-and-persistence-is-a-visible-debt.md)
  (the projection seed moves from bind to open, contained the same way).

## Context

A store permitted `store.bind(lens)` repeatedly, and the engine carried the
machinery of that permission: `boundLenses`, a whole-rebuild loop that
reapplied every binding's schema in bind order, and `projectKvLatest`, a
mutable one-slot KV projector under a last-bind-wins policy, because the
document has exactly one `kv` root and the projection exactly one `kv`
relation. That policy prevents a rebuild from writing an older schema's
columns into the newest relation, but it is ambiguity recovery, not an
ownership model: two returned KV handles could coexist while SQL silently
answered for the most recent interpretation.

The permission had no consumer. Every production caller binds exactly one
declaration per store: honeycrisp, vocab, whispering, skills, sync-lab, the
server's test replica, and every evidence bench. The one true multi-bind
caller was a gitignored bench that imported the host-owned mirror lens
ADR-0226/0227 deleted. Multiple live interpretations survived only in tests,
where rebinding stood in for the close-and-reopen a release upgrade actually
performs, and in ADR-0160's prose, which was written for a model where many
apps shared one namespace.

## Decision

**One application declares one workspace: its namespace, its tables, and its
KV, in one `defineWorkspace({ namespace, tables, kv })` literal. An opened
runtime holds exactly one parsed definition for its whole life.**

```ts
const notes = defineTable({
  title: 'string',
  tags: 'string[]',
});

const preferences = defineKv({
  theme: "'light'|'dark' = 'light'",
});

export const honeycrispWorkspace = defineWorkspace({
  namespace: 'so.epicenter.honeycrisp',
  tables: { notes },
  kv: preferences,
});

const { data } = await openAccount(honeycrispWorkspace, { principalId });
```

`defineTable` and `defineKv` are validation identities, like `defineWorkspace`
itself: the returned value is the argument, and the only work is arktype's
compile-time `type.validate`, moved to the ingredient so an application that
hoists a table to name its row type (`RowOf<typeof notes>`) gets the error at
the table it wrote. There is no fragment composition or runtime merge system:
the application's workspace module writes the one final object.

### The definition is supplied at construction, and nothing rebinds

The engine closes over one `ParsedWorkspace`: every table handle, the KV
handle, the projection schema, and the whole-index rebuild read the same
definition. `bind`, `boundLenses`, and the mutable KV projector are deleted;
the whole rebuild reapplies exactly one schema and one KV projector, and it is
also the seed at open, so there is one rebuild path instead of a seed and a
rebuild that can disagree.

- `open` / `openDevice` / `openAccount` / `openMemory` keep their shapes
  (ADR-0229) and now return a runtime whose view was born with its store.
- `createDeviceStore` / `createAccountStore` take
  `{ workspace, database, ... }` and return the composed data, deleting the
  construct-then-bind two-step everywhere it survived.
- The over-port constructors take the parsed definition and return
  `{ store, view }` parts, because an opener may still wrap the store
  (`discard`) before composing what the application sees.

### Reload is the schema-evolution boundary

Schema evolution is a new release opening the same durable data with a newer
declaration. A page lifetime is one auth generation (ADR-0232); it is also one
definition generation, trivially, because the definition is code. Different
devices naturally run different releases at once; one runtime never holds two
live definitions. Nothing about the durable data changes merely by being
opened under a newer declaration: unknown tables stay in the CRDT and appear
when a declaration that names them opens, unknown fields ride through writes
untouched, and a row a declaration cannot read is reported with `raw` and
`conforming`, never repaired (ADR-0125, ADR-0237). Truly incompatible changes
need an explicit migration, not a rebind.

### The vocabulary is workspace, and the package is `@epicenter/workspace`

The word *lens* was chosen to say "partial, overlapping, release-local, never
canonical" (ADR-0160). Every part of that is now false: the declaration is the
application's complete, canonical description of the durable body of work it
owns. Keeping the word would preserve a connotation the model no longer has.

- `packages/lens` becomes `packages/workspace`; `@epicenter/lens` (never
  published) becomes `@epicenter/workspace`. The npm name is Epicenter's own:
  it carries the deleted ancestor workspace runtime at 0.3.0, so the repo
  version starts at 0.4.0.
- `defineLens` → `defineWorkspace`; `LensJson` → `WorkspaceJson`;
  `parseLens` → `parseWorkspace`; `ParsedLens` → `ParsedWorkspace`;
  `LensParseError` → `WorkspaceParseError`; `LensView` → `WorkspaceView`.
  No aliases.
- "Workspace" was already the store's own vocabulary (`WorkspaceStoreBase`,
  `rebuildWorkspace`, ADR-0231's title): the workspace is the application's
  durable data domain, a store is one opened runtime over one of its
  documents, and rebuilding replaces the workspace's current account
  document. This record makes the declaration side use the same noun rather
  than a second one.

### Runtime-parsed declarations remain supported, for admission

`parseWorkspace` stays the one runtime grammar and stays exported. Its one
production consumer is catalog admission (ADR-0179/0210): an admitted app
ships `workspace.json`, and the host validates it and reads `namespace` and
`title`. Admission never binds; a declaration that arrives as data is a
visible broken artifact, which is why parsing returns a `Result` while the
constructors, which take compile-checked literals, throw on the same refusal
as a programmer error.

## Consequences

- **The engine's ambiguity machinery is deleted**: `boundLenses`,
  `projectKvLatest`, the last-bind-wins policy, the bind-order rebuild loop,
  and the public `bind` verb. A store's typed surface cannot be replaced,
  shadowed, or reinterpreted while it lives.
- **Tests tell the product story.** Rebinding tests became close-and-reopen
  tests over one durable file, and wrong-declaration corruption is authored
  the way it actually happens: a peer replica on a different release syncing
  the value in.
- **`asData` leaves the public barrel** (no external consumer), and the
  openers parse before they claim, so a refused declaration never holds a
  namespace claim.
- **What this forecloses:** a second live interpretation of one open store; a
  mutable projector; schema evolution by rebinding; a runtime schema-merge
  system (feature composition, if it ever earns itself, is designed from real
  callers as authoring-time composition); and a revival of `lens` as a public
  noun.
- **What this does not decide:** document-level migrations and actions on the
  declaration (named as likely future residents of `defineWorkspace`, not
  designed here), and any future out-of-process reader of another
  application's rows, which still requires becoming a replica of that
  application's authority.
