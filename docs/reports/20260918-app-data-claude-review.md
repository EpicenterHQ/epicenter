# Independent Claude consultation

Historical consultation against its recorded snapshot. The accepted current boundary is [ADR-0407](../adr/0407-app-owns-the-declaration-and-data-engine.md): a platform-free declaration, separate App and data openers, private composition, and retired historical helpers. The findings below are preserved as review evidence.

Claude Fable 5.1 reviewed a sealed snapshot. This report preserves its findings and proposed ASCII arrangements; recommendations are not implemented unless listed in the [execution report](20260918-app-data-collapse.md). Claude ran static analysis only. Codex owns live validation and the final disposition.

# Greenfield review: the data engine inside @epicenter/app

Snapshot under review: `30eb69b222cf7d92d4fb9e47a23ce7de3e6fce0c` (`refs/consultation/baseline`), cited below as `path:line@30eb69b`.
Original pre-migration revision: `619afff3c58826defeaeb6b0a52d6666443f836d`, cited as `@619afff`.
Status: COMPLETE. No files outside `.claude-research/` were edited. No experimental source changes were made.

## 0. What could and could not be checked

Unavailable in this sealed snapshot: `bun`, `tsc`, `node_modules`. I ran no tests, no typecheck, no bundles, no benchmarks.
Everything marked MEASURED below is a static measurement made with node scripts kept beside this file:

- `graph.mjs`   runtime import closure of an entrypoint (skips `import type` and all-type brace imports; resolves workspace `exports`, `#imports`, build conditions)
- `names.mjs`   which names each `@epicenter/app/*` subpath actually supplies, inside vs outside the package
- `program.mjs` approximation of a tsc program (follows type imports too) and which reached files carry `/// <reference lib="dom" />`

Everything marked ASSUMPTION needs Codex to confirm in the living checkout. Each has a one-step check in section 6.

## 1. Structural verdict

The consolidation earns its package boundary and most of its module boundaries. Keep one package. Keep `src/data/` grouped.
Keep the independent engine entrypoints. The App lifetime is untouched: `open.ts` differs from `@619afff` only in import lines
(`git diff 619afff -- packages/app/src/open.ts`), and no string literal, namespace, frame, or format constant changed in any moved
engine source file (MEASURED: the non-comment, non-import diff of `packages/app/src/data` is `defineData` removal, two benchmark
`node_modules` paths, and one error-message package name at `definition/compile.ts`).

One structural decision does not hold together, and it is the source of every real finding below:

  ADR-0405 kept the platform-connected root acceptable BECAUSE `defineData` stayed as the platform-free constructor
  (`docs/adr/0405-one-flat-application-declaration-opens-the-live-app.md:43-44,69-70@30eb69b`: "The lower-level data package keeps `defineData` for consumers that declare or open
  data without constructing an application"). ADR-0407 deleted that constructor and kept the platform-connected root.
  So every consumer that only declares a schema now loads the whole platform graph.

MEASURED size of that gap:

| Entry                      | runtime modules | notable externals                              |
|----------------------------|-----------------|------------------------------------------------|
| `@epicenter/app`           | 69              | openai, @ricky0123/vad-web, idb, arktype, @y/y |
| `@epicenter/app/definition`| 14              | @y/y, typebox, wellcrafted                     |
| `@epicenter/app/field`     | 6               | typebox                                        |
| `@epicenter/app/store`     | 31              | @y/y, arktype, nanoid, typebox                 |
| `@epicenter/app/sync`      | 34              | same as store (barrel reaches store.ts)        |
| `@epicenter/app/artifact/format` | 4         | none                                           |

- 56 files construct a declaration with `defineApp({`. 41 of them never call `.open(` in that file. 15 do.
- Production `.open(` call sites: four. `apps/honeycrisp/src/lib/application.ts:21`, `apps/local-mail/ui/src/lib/application.ts:13`,
  `apps/vocab/src/lib/application.ts:20`, `apps/whispering/src/lib/bootstrap.ts:27` (all `@30eb69b`).
- Every one of those four already lives in a module separate from the declaration, loaded by dynamic `import('$lib/application.js')`
  after mount, guarded by a test (`apps/honeycrisp/src/lib/boot-node.test.ts:44-56@30eb69b`). The applications already treat
  declaring and opening as two modules. The package does not.
- There are zero dynamic imports in `packages/app/src` or in the platform modules the root reaches (MEASURED). The words
  "lazy platform modules" in `packages/app/ARCHITECTURE.md`, `packages/app/README.md:73-75`, and ADR-0407 are inaccurate.
  Modules load eagerly. What is deferred is resource acquisition.

Recommendation in one line: keep everything, fix three small regressions now, and as the one worthwhile rearrangement make the
root declaration platform-free by moving the four-line default binding out of `defineApp` into a public opener. That is the only
arrangement in which "exactly one constructor" and "runtime-safe independent consumers" are both structurally true.

## 2. Current arrangement (as implemented at 30eb69b)

### 2a. Packages, entrypoints, consumers

```text
                                   packages/app  (@epicenter/app)
 +-----------------------------------------------------------------------------------------------+
 |  "."  src/index.ts  ------------------------------------------------------------+             |
 |    defineApp  defineTable  field  plainText  jsonValue  types                   |             |
 |    STATIC imports (no dynamic import anywhere):                                 |             |
 |      #platform/resources -> platform/browser.ts | platform/epicenter-host.ts    |  69 modules |
 |      #platform/ai        -> browser.ts          | ai-connections.epicenter-host |  openai     |
 |      ./open.ts           -> data/store/browser.ts (idb), device, blobs, ai      |  vad-web    |
 |                                                                                 |  idb        |
 |  ENGINE ENTRYPOINTS (platform-free, MEASURED)                                   |             |
 |    /definition   14 mod   table vocabulary + compiler + addresses + json        |             |
 |    /field         6 mod   a SECOND `field` object (no `nullable`) + date strings|             |
 |    /store        31 mod   store.ts itself: handle types AND internal constructors             |
 |    /sync         34 mod   ONE barrel: authority half + client half -> store.ts -> @y/y        |
 |    /direct       32 mod   openAccountStore, syncEngineOf                                      |
 |    /memory       33 mod   bun:sqlite test opener                                              |
 |    /artifact     20 mod   /artifact/format 4 mod   /artifact/checkout 19 mod                  |
 |    /store/browser 38 mod  idb persistence; acquireAppData for open.ts                         |
 |    /flush-on-hide  1 mod  ZERO importers        /blobs  ZERO importers                        |
 |  CAPABILITY ENTRYPOINTS                                                                       |
 |    /browser /epicenter-host /ai /ai-connections /native-ai /recorder /clipboard               |
 +-----------------------------------------------------------------------------------------------+

 WHO IMPORTS WHAT (MEASURED, external to packages/app)

 Application authors                        import "."                   open?   platform needed?
   apps/honeycrisp   src/lib/data.ts        defineApp defineTable field   no      no  (application.ts opens)
   apps/vocab        src/lib/data.ts        + DeclaredData from /store    no      no
   apps/whispering   src/lib/data.ts        + runtime override            no      no  (bootstrap.ts opens)
   apps/local-mail   ui/src/lib/data.ts                                   no      no

 Declaration-only consumers forced onto "." when defineData was removed
   packages/skills   src/workspace.ts       reusable library declaration  never   NO  <-- loads 69 modules
   packages/server   workers/replica.ts     workerd Durable Object        never   NO  <-- platform top-levels run in workerd
   apps/sync-lab     worker/test-peer.ts    workerd Durable Object        never   NO  <-- same
   packages/app      evidence/data/workerd/probe.ts                       never   NO  <-- same
   packages/chat     src/index.test.ts, packages/skills tests, app-shell smoke    never   NO
   packages/app      24 engine tests/benches under src/data + evidence/data       never   NO  <-- layering inverted

 Platform-free consumers that stayed platform-free
   packages/chat     src/index.ts           /definition (+ /store type)
   packages/server   src/store-sync/authority.ts   /sync   (deployed Worker; also bundles store + @y/y via the barrel)
   apps/sync-lab     worker/index.ts        /sync   (deployed Worker; same)
   apps/epicenter    src/checkout.ts        /artifact/format     src/routes.ts, server.ts   /artifact/checkout (constants)
   apps/skills       src/lib/application.ts /store/browser  (historical opener; out of scope)
```

### 2b. Internal layering as implemented

```text
   src/index.ts  <----------------------------------------------+   engine tests import UP into the root
      |   \                                                     |   (src/data/**/*.test.ts, __benchmarks__, evidence/data)
      |    +--> #platform/ai, #platform/resources  (DOM, idb, vad, openai)
      v
   src/open.ts --(self-import '@epicenter/app/store', '/store/browser', '/definition')--+
                                                                                        v
   src/data/   artifact --> store <--> sync          store --(self-import '@epicenter/app/definition' x6)--> definition --> field
                              ^          |
                              +----------+   sync/authority.ts --> store/log.ts (copyBytes) --> @y/y
```

Because `open.ts` reaches the engine through public subpaths, internal constructors are public API with zero external users
(MEASURED by names.mjs): `createStoreOverPort`, `StoreUnusableError` on `/store`; `acquireAppData` on `/store/browser`.

### 2c. Lifetime (unchanged from 619afff, shown for completeness)

```text
 defineApp({...})                       module load: binds runtime = resources, ai = createDefaultAppAi()   (index.ts:52-56)
    |  isAppId, compileData (WeakMap cache keyed on the frozen declaration)                                 (index.ts:72, 89-91)
    v
 declaration { id, title?, kv, tables, open }   frozen, inert, no I/O
    |
    | .open(account?)      synchronous                                                                       (open.ts:39)
    v
 App  --- lifetime AbortController
    |   scopes: local always; personal with Account; shared when account.supportsShared                     (open.ts:77-84)
    |   ownership: claimLibrary per scope, sequential, aborts on close                                      (open.ts:85-95)
    |   per scope: createStoreOverPort { acquire -> await ownership -> acquireAppData }                     (open.ts:96-143)
    |   blobs, remote blobs, recorder, inference, secrets, sqlite                                           (open.ts:255-290)
    |
    +-- app.ready   all documents ready -> inference.ready -> not aborted -> not retired; failure closes    (open.ts:228-254)
    +-- account store retirement aborts the whole lifetime                                                   (open.ts:155-160)
    +-- app.close() abort -> stopSync -> close documents + drain sqlite + close capabilities
                    -> only if every document released AND every capability closed: close sqlite, release claims
                    -> canRetryClose only when every failure is a retryable document close                  (open.ts:178-227)
```

## 3. Required fixes (regressions introduced by this change)

None of these touches user data, identities, formats, or lifetime behavior. They are regressions in verification strength and in
the runtime graph, all caused by the same root cause named in section 1.

### R1. The no-DOM typecheck of the engine no longer proves anything   (MEASURED + TypeScript semantics; tsc not run)

`packages/app/tsconfig.data.json@30eb69b` extends `tsconfig.base.json` (`"lib": ["ESNext"]`, no DOM) precisely so that engine code
bound for Workers and Bun cannot name DOM globals. A `/// <reference lib="dom" />` directive in ANY file of a tsc program adds
lib.dom to the WHOLE program.

| no-DOM program                               | root files | program files | reached files carrying `reference lib="dom"` |
|----------------------------------------------|-----------|---------------|-----------------------------------------------|
<!-- doc-path-check: ignore-next-line -->
| `packages/data/tsconfig.json` @619afff       | 101       | 118           | 0                                             |
| `packages/app/tsconfig.data.json` @30eb69b   | 100       | 165           | 6                                             |
| same, engine sources only (no tests/benches) | 40        | 49            | 0                                             |

Chain (one of six): `src/data/__benchmarks__/checkout.bench.ts -> src/index.ts -> src/platform/browser.ts -> packages/blobs/src/browser.ts:1`.
Others land on `packages/device/src/browser.ts:1`, `browser-sqlite.ts:1`, `packages/auth/src/browser-auth.ts:1`, and two more.
24 files included by `tsconfig.data.json` import the root.

Consequence: a future `window.` or `document.` inside `src/data/sync/authority.ts` or `store.ts` would pass `bun typecheck`.
The engine sources are clean today (third row), so nothing is broken yet. The guard is what regressed.

Minimal fix, independent of any API decision: make `tsconfig.data.json` include engine SOURCES only
(exclude `**/*.test.ts`, `**/*.test-d.ts`, `**/*.test-support.ts`, `src/data/__benchmarks__`, and the evidence files that import the root),
and check those under `tsconfig.json`, which already has DOM. The structural fix is section 4, move M1, which makes the exclusion unnecessary.

### R2. Fifteen type-only imports became runtime imports   (MEASURED + TypeScript semantics)

`tsconfig.base.json:28@30eb69b` sets `verbatimModuleSyntax: true`. Under it `import { type X } from 'm'` is preserved as
`import {} from 'm'`, so module `m` is loaded. `import type { X } from 'm'` is erased.
At `@619afff` there were 0 such statements against `@epicenter/data|app` and 17 `import type` forms. At `@30eb69b` there are 15 and 5.
The package declares no `sideEffects` field, so a bundler may not drop them either.

```text
packages/chat/src/index.ts:7                     { type TypedTableHandle }  '@epicenter/app/store'   <-- chat was 14 modules, now reaches 31
packages/skills/src/workspace.ts:9               { type DeclaredData }      '@epicenter/app/store'
packages/server/workers/replica.ts:2             { type ReplicaData }       '@epicenter/app/store'
packages/app/src/data/store/memory.ts:19         { type DataDefinition }    '@epicenter/app/definition'
apps/honeycrisp/src/lib/app.svelte.ts:2          { type RowAbsentError }    '@epicenter/app/store'
apps/vocab/src/lib/data.ts:8                     { type DeclaredData }      '@epicenter/app/store'
apps/vocab/src/lib/state/settings.svelte.ts:14   { type AppStore }          '@epicenter/app'
apps/vocab/src/lib/state/inference-connections.svelte.ts:1  { type App }    '@epicenter/app'
apps/whispering/src/lib/data.ts:9                { type DeclaredData }      '@epicenter/app/store'
apps/whispering/src/lib/platform/runtime.browser.ts:1         { type ApplicationRuntime } '@epicenter/app'
apps/whispering/src/lib/platform/runtime.epicenter-host.ts:1  { type ApplicationRuntime } '@epicenter/app'
apps/whispering/src/lib/whispering/recipes.svelte.ts:17       { type NonconformingRow }   '@epicenter/app/store'
apps/whispering/src/lib/whispering/recordings.ts:1            { type NonconformingRow }   '@epicenter/app/store'
apps/skills/src/lib/state/skills-state.svelte.ts:2            { type NonconformingRow }   '@epicenter/app/store'
apps/skills/src/lib/application.ts:13            { type ReplicaData }       '@epicenter/app/store'
```

Fix: restore `import type { ... }` in all fifteen. The deleted comment in `packages/chat/src/index.ts` at `@619afff` explained why that
package kept the two imports apart; the rewrite dropped both the distinction and the explanation.
ASSUMPTION: Vite/esbuild and Bun honor `verbatimModuleSyntax` from tsconfig the way tsc does. tsc's behavior is documented.

### R3. Agent instructions still teach the deleted API   (MEASURED)

`.agents/skills/typescript/references/testing-patterns.md:16,35,68`, `.agents/skills/typescript/references/runtime-schema-patterns.md:58`
(`import { field } from '@epicenter/data/field'`), `.agents/skills/agent-instructions/SKILL.md:185`,
`.agents/skills/pull-request/references/visual-patterns.md:76` still name `defineData` and `@epicenter/data`.
The collapse report says no executable constructor named `defineData` remains, which is true, but these files instruct the next agent to write one.

### R4. Documentation states a loading model the code does not have   (MEASURED)

"lazy platform modules" / "yes, lazy" in `packages/app/ARCHITECTURE.md:110,125`,
`packages/app/README.md:73-75`, and `docs/adr/0407-app-owns-the-declaration-and-data-engine.md:25` ("Full declarations load lazy application modules"). There is no dynamic import.
Say instead: the root statically loads the platform modules; constructing them acquires nothing. If move M1 is taken this sentence disappears.
Also `docs/licensing/licensing-strategy.md` now reads "`@epicenter/app/store`, the headline toolkit root, was never published",
which rewrites a historical statement about `@epicenter/data` into something that was never true.

### Regression RISKS that pass today (report, do not block)

- K1. Three workerd harnesses now execute the browser platform's module top-levels inside workerd:
  `packages/server/workers/replica.ts:1`, `apps/sync-lab/worker/test-peer.ts:21`, `packages/app/evidence/data/workerd/probe.ts`.
  That includes `createBrowserSqliteOwner()` and `createBrowserAppBlobs()` at `src/platform/browser.ts:27-32@30eb69b`, the openai SDK, and
  `@ricky0123/vad-web` with its onnxruntime dependency. The report says the 32 Worker tests pass, and I believe it. The exposure is that
  any future top-level browser-global access in roughly forty platform modules breaks server suites that have nothing to do with the platform.
  `import-boundaries.test.ts` checks the root under Bun with globals deleted; it does not check workerd.
- K2. `import-boundaries.test.ts:42-48` covers `definition, store, direct, sync, artifact/format`. It omits `field`, `memory`, `artifact`,
  `artifact/checkout`. Its forbidden-path pattern omits `ai.ts`, `ai-connections*.ts`, `native-ai.ts`, and the `openai` package.
- K3. Deployed Workers are safe: `packages/server/src/store-sync/authority.ts:2-8` and `apps/sync-lab/worker/index.ts:13-19` import only `/sync`.
  Test entries alone mount the harnesses (`apps/sync-lab/worker/test-entry.ts:13`).

## 4. Optional rearrangement, in priority order

### M1. Make the declaration platform-free; open through a public opener   (the one rearrangement I recommend)

Move: the default binding out of `defineApp` (`src/index.ts:53-54, 73-81@30eb69b`) into a small public module that wraps the existing
`openApp` in `src/open.ts`. `src/open.ts`'s body does not change. The lifetime diagram in 2c does not change.

```ts
// @epicenter/app            platform-free, about the size of /definition today
export function defineApp<const T extends DataDefinition>(schema: T & { kv: ...; tables: ... }): T   // frozen, eager compile, no `open`

// @epicenter/app/open       the only entry that imports #platform/*
export function openApp<T extends DataDefinition>(definition: T): App<T, undefined>;
export function openApp<T extends DataDefinition, A extends Account | undefined>(
  definition: T, account: A, overrides?: { runtime?: ApplicationRuntime; ai?: AppAiBinding },
): App<T, A>;
```

What it deletes: the `Application<T>` type and the `Pick<...>` title gymnastics (`index.ts:32-38, 67-70`); the `runtime`/`ai` parameters
on the constructor; the index.ts <-> open.ts <-> browser.ts type cycle; the special-case fresh-process test for the root (the root joins
the platform-free list in `import-boundaries.test.ts`); the need for R1's exclusion list; risk K1 entirely.
It also makes `packages/app/README.md:50-51` literally true: "Runtime and AI overrides stay in the opener's closure, outside the schema."

What callers change (MEASURED counts):
- 4 production lines: `honeycrispDefinition.open(account)` becomes `openApp(honeycrispDefinition, account)` plus one import, in the four files
  listed in section 1. Those files are already the dynamically imported opening modules, so the platform graph moves into the chunk the
  applications already intended to defer.
- `apps/whispering/src/lib/data.ts:12,160`: the `runtime` import and property leave the schema file and go to `bootstrap.ts`.
  Observation outside this task: that override selects `browser` by default and `epicenterHost` under `epicenter-host`, which is exactly what
  `#platform/resources` already selects, so it is a no-op today.
- 3 boot tests assert the literal string `Definition.open(account)` (`apps/{honeycrisp,vocab,whispering}/src/lib/boot-node.test.ts`).
- Package tests: `app.test.ts` (66 opens, 59 overrides), `index.test.ts`, `scopes.test.ts`, `recording.test.ts`, `blob-retirement.test.ts`,
  `index.test-d.ts`, `whispering/app.test.ts`. Mechanical: the override object moves from the constructor call to the open call.
- The 41 declaration-only files change nothing.

What I tried in order to disprove it:
- Does anything consume `.open` structurally? No. The only `Application` type users outside the package are an unrelated type in `apps/epicenter`.
- Does moving the default AI binding from per-declaration to per-open change behavior? `createBrowserAppAi` and `createEpicenterHostAppAi`
  return closures with no captured state that I can see (`src/browser.ts:10-51`, `src/ai-connections.epicenter-host.ts:250-256`,
  `src/native-ai.ts:7-17`). ASSUMPTION until tests run. Hoisting one module-level default in the opener module preserves today's sharing exactly.
- Can `.open()` stay while the root becomes platform-free? Only by dynamic import inside a synchronous method that returns synchronous
  capabilities, which means rewriting the lifetime. Rejected: lifetime correctness is not negotiable.
- Is a second platform-free constructor the cheaper answer? Yes, and it is ruled out by the settled outcomes. M1 is what that ruling implies.

If M1 is declined, the status quo is a defensible, verified arrangement. Then R1's exclusion list becomes permanent and K1 should be written
into ADR-0407 as an accepted cost, because ADR-0407's stated reason for keeping `.open()` ("no migrated consumer requires that contract")
does not survive the measurements above: seven migrated consumers and 24 engine test files do.

### M2. Split the sync barrel so "the authority reads nothing" is structural

`src/data/sync/index.ts` exports the server authority half (`authority.ts`, `hub.ts`, `frames.ts`) and the client half
(`attach.ts`, `client.ts`, `connection.ts`, which import `store/store.ts`). The authority half's only tie to the store is a four-line
byte copy: `sync/authority.ts:67 -> store/log.ts:181 copyBytes`, and `log.ts:15` imports `@y/y`.
Move `copyBytes` into `frames.ts` or a `bytes.ts` leaf. Add `./sync/authority` exporting authority + hub + frames. The deployed Worker's
graph drops from 34 modules with Yjs, typebox, arktype, nanoid to 3 modules with wellcrafted. Pre-existing at `@619afff`, not a regression.
Callers: `packages/server/src/store-sync/authority.ts`, four server tests, `apps/sync-lab/worker/index.ts`, and the `CurrentAuthority`/`Frame`
type imports in `apps/honeycrisp`. Add the new entry to `import-boundaries.test.ts` with `@y/y` forbidden.

### M3. One `field`, and no `/field` entry

Two different public objects are named `field`: `src/data/field/builders.ts:283` (exported at `/field`, no `nullable`) and
`src/data/definition/declaration.ts:210-213` (exported at the root and `/definition`, with `nullable`). All 19 external imports of `/field`
take `InstantString` and nothing else. Delete the `./field` export; `/definition` already re-exports `InstantString`, `CalendarDateString`,
`DateTimeString`, `recognize`. With M1 the root can export them and most of the 19 become root imports. Callers: 19 one-line import changes.

### M4. Stop publishing internals; give `/store` a facade

External use of `/store` is six TYPES and nothing else: `NonconformingRow, DeclaredData, ReplicaData, RowAbsentError, PersistenceCapability,
TypedTableHandle`. `./store` points at the 1402-line implementation file, so `createStoreOverPort`, `registerSyncConnection`, `StoreBacking`
are public by accident. Switch `open.ts` and the six `src/data/store/*.ts` self-imports to relative paths, then point `./store` at a small
`store/index.ts` of types and errors. Export `DeclaredData` from the root as a type: three of five declaration files
(`apps/vocab`, `apps/whispering`, `packages/skills`) need a second import path only for it, which contradicts ADR-0407's "one package, one root".
`acquireAppData` leaves `/store/browser`; that entry then serves only the out-of-scope Skills opener and can be deleted when Skills migrates.

### M5. Delete two dead exports

`./flush-on-hide` (only `store.ts:32` uses it, relatively) and `./blobs` (only `blobs.test.ts`, relatively). Zero callers change.

### Not recommended

- Flattening `src/data/`. ADR-0407 is right: it names a coherent engine and removing the directory simplifies no caller.
- Re-splitting the package. The root cause is where the platform binding sits, not which package owns the engine.
- Reorganising `src/` platform leaves (`browser.ts` vs `ai-connections.epicenter-host.ts` behind `#platform/ai` is asymmetric). Real but cosmetic; zero callers.

## 5. Recommended arrangement (M1 through M5 applied)

```text
                                   packages/app  (@epicenter/app)
 +-----------------------------------------------------------------------------------------------+
 |  "."  src/index.ts                         PLATFORM-FREE   (about 15 modules: definition + field)
 |    defineApp -> frozen { id, title?, kv, tables }        no `open`, no runtime, no ai         |
 |    defineTable  field  plainText  jsonValue  InstantString  CalendarDateString  DateTimeString|
 |    types: RowOf KvOf CreateRowOf ContentCodec DataDefinition DeclaredData App AppStore        |
 |                                                                                               |
 |  "./open"  src/open-default.ts  ->  src/open.ts (UNCHANGED BODY)       the ONLY platform edge |
 |    openApp(definition, account?, { runtime?, ai? })                                           |
 |      #platform/resources   #platform/ai   data/store/browser.ts (relative, not public)        |
 |                                                                                               |
 |  ENGINE ENTRYPOINTS                                                                           |
 |    /definition         compiler, addresses, canonical, json guards   (schema tools)           |
 |    /store              store/index.ts: six handle/error TYPES + StoreError                    |
 |    /sync               client half: attach, client, connection, frames                        |
 |    /sync/authority     authority, hub, frames                         NO store, NO @y/y       |
 |    /direct  /memory  /artifact  /artifact/format  /artifact/checkout   unchanged              |
 |    /store/browser      Skills' historical opener only; delete with that migration             |
 |    removed: /field  /flush-on-hide  /blobs                                                    |
 |  CAPABILITY ENTRYPOINTS   /ai /ai-connections /native-ai /recorder /clipboard   unchanged     |
 |    /browser /epicenter-host   remain only if a caller passes a non-default runtime            |
 +-----------------------------------------------------------------------------------------------+

 Application authors          data.ts         import "."            platform-free, first chunk, Bun tests, schema tools
                              application.ts  import "./open"       platform graph lands in the dynamically imported chunk
 Reusable features            chat, skills    import "."            one import path; no platform; Node-safe
 Worker test harnesses        replica, test-peer, probe   "." + /direct + /sync     nothing browser-shaped enters workerd
 Deployed authorities         server, sync-lab worker     /sync/authority           3 modules, opaque bytes only
 Desktop host                 apps/epicenter              /artifact/format, /artifact/checkout constants
 Engine tests                 src/data/**     import "."            sideways into definition, never up into open.ts

 Internal layering
   src/open-default.ts --> src/open.ts --> data/store/browser.ts        (relative imports; nothing above the engine is reachable from it)
        |                       |
        +--> #platform/*        v
   src/index.ts ---------> data/definition --> data/field
                           data/artifact --> data/store <--> data/sync(client)
                           data/sync(authority) --> frames        (no edge to store)

 Lifetime: identical to 2c. The only difference is the first box:
   openApp(definition, account?, overrides?)   binds runtime = overrides.runtime ?? resources, ai = overrides.ai ?? defaultAi
      -> the existing openApp(definition, { appId: definition.id, account, sqlite, secrets, blobs, recording, ai })
```

## 6. One-step checks for Codex (all unavailable here)

1. R1: add `export const probe = window.location;` to `packages/app/src/data/store/log.ts`, run
   `tsc --noEmit -p packages/app/tsconfig.data.json`. I predict NO error at the migrated tree, and an error for the same probe under
<!-- doc-path-check: ignore-next-line -->
   `packages/data/tsconfig.json` at `619afff`. If the migrated tree does error, R1 is wrong and should be dropped.
2. R2: build `packages/chat/src/index.ts` with `Bun.build({ metafile: true })` and look for `data/store/store.ts` in the inputs.
   Repeat after changing line 7 to `import type`.
3. K1: no action needed beyond reading the measured graph; optional `wrangler`/vitest bundle metafile of the replica entry.
4. M1 feasibility: `bun test --isolate` in `packages/app` after the mechanical move; `index.test-d.ts` must keep the account-presence overloads.
5. M2: after moving `copyBytes`, `Bun.build` of `./sync/authority` must list no `@y/y` input.

## 7. Open questions

- Does any planned consumer need a non-default `runtime`? If not, `/browser`, `/epicenter-host`, Whispering's `#platform/runtime`, and the
  `runtime` override can all go with M1. That is a separate decision (README cites ADR-0391 and ADR-0403) and I did not pursue it.
- `apps/honeycrisp/src/lib/folder-overview.ts:247` contains literal NUL bytes as a key separator, so `file` and `grep` treat the source as
  binary. It is the same at `619afff`. Unrelated to this change; worth an escape sequence someday.
