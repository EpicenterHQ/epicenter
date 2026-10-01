# Data opening consultation

Current API decisions are recorded in [ADR-0407](../adr/0407-app-owns-the-declaration-and-data-engine.md). This report preserves its earlier checkpoint; historical helpers and public runtime overrides are now retired without migrating old bytes.

Claude Fable 5.1 reviewed sealed snapshot `fd1132aa18bf88f4b580c269c30fd336ca9ce033` before implementation. Its recommendation was accepted: `/data` owns caller-supplied SQLite; `/memory` remains Bun convenience; application opening owns resources. The observations below describe the reviewed snapshot. Current behavior is recorded in [ADR-0407](../adr/0407-app-owns-the-declaration-and-data-engine.md). The consultant ran static research only; Codex validated the implementation in the live checkout.

# Data-only opening boundary: `openData` vs `openMemory`

Baseline `eb5f42f856` (refs/consultation/baseline). Citations are `path:line@eb5f42f856`.
Read-only research; no source edits, no experiments. Status: **complete**.

## Recommendation

**`openData(definition, sqlite)` is the data-only boundary. `openMemory(definition, record?)` stays, unchanged, as Bun test sugar over it. `openAccountStore`, `CreateStoreOptions`, the `dispose` option and the `/direct` subpath leave the public surface.**

This is not a naming choice. The two functions are different layers, and only one of them can be the boundary:

- `openMemory` statically imports `bun:sqlite` (`packages/app/src/data/store/memory.ts:18,21`). It cannot be bundled into workerd or a browser. Three Durable Object harnesses and one sqlite-wasm page need a data-only store and can never call it (`packages/server/workers/replica.ts:105-111`, `apps/sync-lab/worker/test-peer.ts:51-55`, `packages/app/evidence/data/workerd/probe.ts:82`, `apps/sync-lab/ui/main.ts:39-43`). `import-boundaries.test.ts:59` already has to special-case `memory` as `target: 'bun'`.
- `openMemory` is six lines over the general opener (`memory.ts:54-59`). The reverse derivation is impossible. So the general opener earns its place by necessity; `openMemory` earns its place by volume (20 files, ~150 callsites, 44 in `store.test.ts` alone) and by encoding one ownership rule. Neither should be deleted; only one is the boundary.
- "Memory" is false for every caller of the general opener: DO SQLite is durable, `apps/whispering/src/lib/whispering/recordings.test.ts:36` opens a file. "Account" is equally unearned: the opener takes no account and "claims no address" (`memory.ts:13-16`). The opener returns `Data<T>` (`store/handles.ts:320-322`), as `openApp` returns `App`; that is the grounding for `openData`.
- Worker probes cannot be folded into `openApp`: it acquires IndexedDB, Web Locks and device resources (`packages/app/src/open.ts:89,107`), none of which exist in workerd, and the probes say they deliberately test "real sync and storage, not the browser IndexedDB bootstrap" (`replica.ts:18-19`).

## What data-only callers actually need (measured)

| Population | Files | Need | Served by |
| --- | --- | --- | --- |
| Bun tests, throwaway store | 20 files call `openMemory(def)` | typed `tables`/`kv`, `await using`, no thought about the record | `openMemory(def)` |
| Bun tests, close + reopen same bytes | `packages/chat/src/index.test.ts:36-61`, `packages/skills/src/skills.test.ts:67-115` (historical definition then current over ONE record = the historical-data refusal/upgrade case), `apps/local-mail/ui/src/lib/data.test.ts:16-30`, `store.test.ts`, `artifact/import.test.ts`, `checkout.bench.ts:34-35,166` | record outlives stores; caller closes it | `createMemoryRecord()` + `openMemory(def, record)` |
| Non-Bun runtime, caller-owned SQLite | `replica.ts`, `test-peer.ts`, `probe.ts` (DO SQLite), `sync-lab/ui/main.ts` (sqlite-wasm) | `{definition, sqlite}` only; never `dispose`, never `log` | `openData(def, sqlite)` |
| Hand-rolled `openMemory` | `packages/server/src/store-sync/browser-dial.test.ts:99-106`, `packages/app/src/data/sync/attach.test.ts:45-51`, `apps/whispering/src/lib/operations/pipeline.test.ts:125-130`, `connection.test.ts:159,504,568` | identical to `openMemory(def)`; `dispose: () => live.close()` exists only to rebuild it | migrate to `openMemory(def)` |
| Raw-handle engine tests | `store/sync.test.ts:35-47,237-267`, `sync/transport.test.ts:155` (holds the handle), `store.test.ts:1042` (`log`) | inspect `_updates` rows, inject a logger | in-package relative import of the internal function |
| `syncEngineOf` | `replica.ts:135,141`, `honeycrisp/scripts/library-retirement.ts:260`, `local-mail/ui/evidence/browser/main.ts:63,76,109`, honeycrisp/local-mail tests | test/probe seam for `applyRemote`/`encodeSnapshot` | stays beside `openData` |

Every external use of `dispose` is a hand-rolled `openMemory`; no external caller passes `log`. So the public general opener needs exactly two positional arguments.

`apps/skills/src/lib/application.ts:48` uses a third opener, `openDatabase` from `/store/browser`. Skills is documented as deliberately broken (`application.ts:5-10`); it should move to `openApp`, not to `openData`. Out of scope for this decision, but it must not be used as an argument for a browser data-only opener.

## Ownership and semantics (to preserve exactly)

- **Record**: `openData` never closes the SQLite it is handed; the caller owns it. `openMemory` closes a record only when it minted it (`memory.ts:46-48,58`). `MemoryRecord = { sqlite, close }` is unchanged. That single rule is what makes reopen meaningful.
- **Close/reopen**: `Data<T>` carries `Symbol.asyncDispose` because these constructors acquire one thing (`store.ts:384-392`, `handles.ts:333-335`). Close drains persistence; a repeated dispose retries (`store.ts:966-974,1002`). Reopen = dispose, then `openData`/`openMemory` over the same record. **No `ready`, no `close`, no `canRetryClose` on this surface**; failure to open throws (`store.ts:381-383`). That keeps `openApp` the only public lifecycle.
- **Scopes**: the data-only opener always opens replica semantics (`local` is not an option of `CreateStoreOptions`, `store.ts:315-322`; default `false` at `store.ts:412`). local/personal/shared remain `openApp`'s alone (`open.ts:77-84`). Do not add a scope parameter.
- **Retirement / library replacement**: inert on a SQLite backing. `overSqlite` supplies neither `replication` nor `discard` (`store.ts:351-355`), so `onRetired` returns early (`store.ts:455`). Retirement, retryable close of an invalidated generation, and claim release stay in `openApp` + `acquireAppData`. `openData` changes none of it.
- **Durable replay / data formats**: untouched; `openData` is `openAccountStore` with its arguments reordered. Same `createSqliteDurablePort`, same `createStoreOverPort`.
- **No address claim**: two stores over one SQLite are not refused (`sync.test.ts:238-248` relies on it). Keep; it is documented (`memory.ts:13-16`).

## Exact final surface

```ts
// @epicenter/app/data        (replaces ./direct; platform-free, bundles for workerd + browser)
export function openData<const T extends DataDefinition>(
  definition: T,
  sqlite: SqliteDatabase,          // caller-owned; never closed by the store
): Promise<Data<T>>;               // AsyncDisposable
export { syncEngineOf };

// @epicenter/app/memory      (Bun only; unchanged)
export type MemoryRecord = { readonly sqlite: SqliteDatabase; close(): void };
export function createMemoryRecord(): MemoryRecord;
export function openMemory<const T extends DataDefinition>(
  definition: T, record?: MemoryRecord,
): Promise<Data<T>>;
```

Internal (not exported): `openAccountStore(options)` keeps `dispose`/`log` in `store/store.ts` for `memory.ts` and the engine tests, which already import relatively.

Callsites after migration:

```ts
// packages/server/workers/replica.ts:108, apps/sync-lab/worker/test-peer.ts:54, evidence/data/workerd/probe.ts:82
await openData(probeDefinition, createDurableObjectSqliteAdapter(this.ctx.storage))
// apps/sync-lab/ui/main.ts:40
await openData(labDatabase, createBrowserSqliteAdapter(new sqlite3.oo1.DB(':memory:')))
// browser-dial.test.ts:99, attach.test.ts:45, pipeline.test.ts:126, connection.test.ts
await openMemory(definition)
// whispering/recordings.test.ts:36-43  (file-backed reopen)
const sqlite = new Database(join(root, 'rows.sqlite'));
const data = await openData(whisperingDefinition, createBunSqliteAdapter(sqlite)); // test closes sqlite in its cleanup
// chat, skills, local-mail, honeycrisp, whispering export tests: no change
```

Deletion/migration impact: `package.json` `./direct` -> `./data`; `src/data/direct.ts` becomes a 10-line `openData` wrapper; `CreateStoreOptions` leaves the export; 11 import sites of `/direct` change path (6 of them only for `syncEngineOf`); ~7 files swap a hand-rolled opener for `openMemory`; `import-boundaries.test.ts:46-56` list renames `direct` -> `data`. Zero change to the ~26 `openMemory` files. `/store` and `/store/browser` trimming is a separate, already-reported item.

## Test injection for application resources (no public runtime options)

Split `open.ts` in two, inside the package:

- `src/open.ts` (public `@epicenter/app/open`): `openApp(definition, account?)` = `composeApp(definition, { ...resources, ai: createDefaultAppAi(), account })`, importing `#platform/resources` and `#platform/ai`.
- `src/compose.ts` (**no `exports` entry**): today's `openApp(definition, OpenOptions)` body (`open.ts:28-330`) verbatim, renamed `composeApp`.

In-package tests import `./compose.js` relatively. This is already the practice, not an invention: `app.test.ts:32,196` imports `openApp` from `./open.js` with full options today. It is one lifecycle (the same function production runs), not a second one, and it is the only thing that satisfies the tests' real needs: they need *programmable* resources per test (an owner whose `delete` blocks, `app.test.ts:266-295`; failing blobs `:522-536`; AI transports `:901-1105`), which a static condition leaf cannot supply. 59 override sites in `app.test.ts` plus `index.test.ts:48-117`, `blob-retirement.test.ts:105`, `scopes.test.ts`, `recording.test.ts` change mechanically from `defineApp({...def, runtime, ai}).open(a)` to `composeApp(def, {...browser, sqlite, ai, account: a})`. Add `compose\.ts` to the forbidden-path regex at `import-boundaries.test.ts:80`.

The only out-of-package injector is `apps/whispering/src/lib/whispering/app.test.ts:170-193`, and it does not need an App:
- its `sqlite` stub is never exercised (acquisition is lazy, `packages/device/src/owner.ts:192-198`; the Worker is lazy, `browser-sqlite.ts:41-43`), its `blobs` override is the default (`createBrowserAppBlobs()`), and `ai: null` exists only because the browser default reads `window.localStorage` (`packages/app/src/browser.ts:20`) eagerly at open (`open.ts:276`).
- Test 1 ("constructing a factory acquires no local database", `:184`) becomes true by construction once `defineApp` is platform-free; delete it (import-boundaries covers it). Tests 2 and 3 (`:203,:249`) test settings over `device.kv` and domain disposal; rebuild them over `openMemory(whisperingDefinition, record)` with a structural handle, as `pipeline.test.ts:126-139` and `recordings.test.ts:36-52` already do for the recordings domain.
- Whispering's `#platform/runtime` seam (`apps/whispering/src/lib/data.ts:12`, `platform/runtime.*.ts`, `package.json:59`, `bootstrap-failure.test.ts:63`) and `@epicenter/app/browser` / `/epicenter-host` as *runtime values* are deleted with the public override.

Rejected: a `@epicenter/app/testing` export (public runtime overrides under another name); a third `epicenter-test` condition leaf (static, so it cannot serve `app.test.ts`; also unverified under `bun test`, and `platform-selection.test.ts:31-36` pins exactly two conditions); `mock.module('#platform/resources')` from outside the package (`#` specifiers resolve against the importer's own `imports` map).

## Material objections

1. *"Two openers is one too many."* The `bun:sqlite` import forces two modules the moment any Bun helper exists; `createMemoryRecord` must exist for the reopen tests. Deleting `openMemory` but keeping the record saves 10 lines and turns ~150 callsites into `openData(def, createMemoryRecord().sqlite)` with a leaked handle. Not worth it.
2. *"`@epicenter/app/data` resurrects the old package's name."* It exports two names. If that is unacceptable, keep the `./direct` path and rename only the function; the ownership decision is unaffected.
3. *"`syncEngineOf` is package-internal by convention"* (`store.ts:265-266`) yet sits on the boundary. True and pre-existing; 6 external harness files depend on it. Leave it; do not widen it.
4. *Dropping public `dispose` removes ownership transfer.* No external caller uses it for anything but rebuilding `openMemory`. If a future non-Bun caller needs it, add then.
5. *Relative-import test seam is convention, not enforcement.* Correct; the enforcement is the absent `exports` entry (isolated linker, `bunfig.toml:6`) plus the import-boundaries regex.

## Checks

Run: `git grep`/file reads only, against `eb5f42f856`.
Unavailable: `bun`, `tsc`, `node_modules` are absent. No tests, typecheck, or bundles were run. Unverified assumptions: (a) Whispering tests 2-3 can be expressed over a structural handle without widening `WhisperingAppHandle` (type-level check needed); (b) the `openData` wrapper module still bundles for workerd with no `open.ts`/platform inputs (same graph as `/direct` today, so expected).

## Open questions (none blocking)

- Subpath `./data` vs keeping `./direct` (objection 2).
- Whether `apps/skills` moves to `openApp` in this wave or stays parked.
