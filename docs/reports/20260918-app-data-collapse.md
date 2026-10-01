# App and data package collapse

`@epicenter/app` owns declaration, lifetime, and the data engine.
`packages/data` and `defineData` are removed. Application authors import
`defineApp`, `defineTable`, and `field` from one root.

The [architecture map](../../packages/app/ARCHITECTURE.md) contains the full
ASCII consumer diagram, source ownership tree, and runtime-entrypoint map.
The [decision record](../adr/0407-app-owns-the-declaration-and-data-engine.md)
records the package boundary.

## Scope and review

The task started from clean revision `619afff3c58826defeaeb6b0a52d6666443f836d`.
The unrelated untracked integration-review report was left untouched.

An independent design review before migration verified that a declaration
can retain synchronous `.open()` without acquiring browser resources. The
intermediate review found and corrected benchmark paths and the moved browser
build ignore rule. It also identified the transplanted data-root barrel as
redundant. That barrel was deleted: store types live on `/store`, browser
persistence on `/store/browser`, and the root exports authoring vocabulary
explicitly.

The source remains grouped under `src/data/`. No persisted identifier, schema
field, library namespace, artifact format, wire frame, or App lifetime changed.
Skills retains its historical opener; moving its declaration does not migrate
its startup behavior.

Focused post-implementation evidence:

```text
packages/app/
|-- package.json
|-- tsconfig.data.json, tsconfig.data.dom.json
|-- src/
|   |-- index.ts, index.test.ts, index.test-d.ts
|   |-- open.ts, import-boundaries.test.ts
|   `-- data/
|       |-- definition/{define,compile,declaration,index}.ts
|       |-- store/{store,port-conformance.test}.ts
|       |-- direct.ts
|       `-- __benchmarks__/{root-rotation,checkout}.bench.ts
`-- ARCHITECTURE.md
packages/{chat,skills}/src/{index,workspace}.ts
packages/server/{src/store-sync/authority,workers/replica}.ts
apps/{honeycrisp,vocab,whispering}/src/lib/data.ts
```

## Validation

- Full repository `bun typecheck` passes after migration and export cleanup.
- App: 799 tests pass, including eleven fresh-process declaration and bundle
  boundary checks. The neutral entrypoint bundles contain no App lifetime,
  browser/native resource composition, or Tauri implementation.
- Server: 154 Bun tests and 32 real Worker tests pass.
- Chat, Skills, Svelte, App Shell, Vocab, Whispering, Epicenter, Sync Lab, and
  Local Mail schema tests pass. Epicenter's tests build and serve application
  bundles, including Honeycrisp and Whispering.
- Honeycrisp: all 29 tests pass with `bun test --isolate`.
- Browser recording smoke passes: record, decode, cancel, close/reopen, and
  offline playback. Both relocated benchmarks run successfully.
- Catalog pins, UI boundary, boot purity, and vocabulary checks pass.
- No source imports, package dependencies, or lockfile entries name the deleted
  package. No executable declaration constructor named `defineData` remains.

The default Honeycrisp test command has six failures from a mock leaking into
its node-text tests. The same six failures reproduce at the task-start revision
in a separate checkout; the six tests also pass alone. The package's test
command was left unchanged.

The structure command is not fully green: eleven old documentation paths and
two hardcoded API paths fail at both the task-start revision and the completed
migration. The moved-file references introduced by this change were repaired.
Eight lint errors in moved or import-updated files also reproduce at the
baseline; no new lint error was introduced. Checks requiring tracked new files
used an alternate Git index, leaving the working index unchanged.

## Final architecture consultation

Claude Fable 5.1 completed the requested sealed-snapshot consultation through
the [consult-claude skill](../../.agents/skills/consult-claude/SKILL.md). The
[full report](20260918-app-data-claude-review.md) includes current and proposed
ASCII package, consumer, source, and lifetime diagrams. Its measurements are
static import-graph counts, not bundle-size or runtime measurements. Dependencies
and runtime tools were unavailable inside the snapshot; Codex ran live checks.

Accepted and verified corrections:

- Restored eighteen erased type-only imports. With verbatimModuleSyntax,
  an all-type brace import can emit an empty runtime import. Verified with the
  installed TypeScript compiler; App, Chat, Skills, and Server checks pass.
- Restricted the no-DOM engine check to production engine sources. Tests remain
  in the main App check; evidence is checked under the DOM leaf or its dedicated
  harness config. The resolved compiler file list contains no lib.dom or
  application platform module. All App typecheck leaves pass.
- Updated twelve agent guidance files that referenced the removed package or
  constructor, including obsolete schema examples.
- Corrected documentation: modules load statically; resource acquisition waits
  for opening. Restored the historical licensing reference to the old package.
- Expanded bundle boundary coverage to field, memory, artifact, and checkout,
  and rejected AI implementation imports. All 799 App tests pass afterward.

The review supports one package and retaining the coherent data directory. Its
main recommendation is a platform-free root plus a separate public opener.
Codex agrees this is the stronger greenfield target: full declarations currently
reach platform modules even in schema-only consumers. No observed runtime
failure requires an emergency lifetime rewrite. This API rearrangement is left
visible for the requested design consideration rather than silently included
after the final consultation.

Other proposed follow-ups are a server-only sync entrypoint, one public field
object, a narrower store facade, and deletion of unused subpath exports. These
are not implemented. The duplicate field export and broad engine barrels were
retained from the old package; they are cleanup opportunities exposed by the
collapse, not new data or lifetime changes.

No live source changes from Claude were copied. The working index was not
staged, and no commits were made.
