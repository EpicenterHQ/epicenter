# One App lifetime over a complete runtime

**Date**: 2026-09-18
**Status**: In Progress
**Owner**: Codex implementation and integration; independent Codex and Claude review

## One sentence

Open production and test Apps through one lifecycle that admits a storage owner
once and obtains all resources from a complete runtime.

Current code exposes `openApp(definition, account?)`, claims each library, and
claims SQL separately. Target: `openApp(definition, { account?, runtime? })`, one
admission, and memory storage that survives App close. Completion requires the
same App behavior under both runtimes, caller migration, safe close failures,
and real browser/host evidence. Implementation is underway; wave checkpoints below distinguish completed work.

The API direction is recorded in [0408](../docs/adr/0408-one-app-opener-uses-a-complete-runtime.md).
The bounded ownership refinement is proposed in [0409](../docs/adr/0409-one-app-admission-covers-its-storage.md).

## Target shape

```text
inert definition + captured account + complete runtime
                         |
                      openApp
                         |
                 one App admission
                  /             \
          AlreadyOpen         acquired
                                |
                    document/SQL/blob resources
                                |
                         ready -> usable
                                |
                       close -> fence -> drain
                                |
                    cleanup succeeds? -- no --> retain admission
                                |
                               yes
                                |
                             release

runtime storage survives App.close()
runtime.dispose() requires every App to have released
account-wide AI catalog has its own coordination domain
```

The runtime contract extends the current resource bundle with admission and
document acquisition, and includes the AI binding. Keep methods explicit;
there is no service registry, partial merge with defaults, or second App opener.
The build selects a complete default runtime. A separate test-support entrypoint
exports the memory runtime without adding fake storage to declaration imports.

`openData` and engine `openMemory` remain for caller-owned SQL and independent
replica tests. The App runtime does not simulate account authority or silently
disable network transport supplied by an Account. Recording and inference are
unavailable unless an explicit fixture supplies them.

## Real callsites

Honeycrisp, `apps/honeycrisp/src/lib/application.ts`:

```ts
// Before
export const app = new URLSearchParams(location.search).has('connect')
  ? null
  : openApp(honeycrispDefinition, account);
// After
export const app = new URLSearchParams(location.search).has('connect')
  ? null
  : openApp(honeycrispDefinition, { account });
```

Whispering, `apps/whispering/src/lib/bootstrap.ts`, inside its existing guarded
opening and error-handling block:

```ts
// Before
return openApp(whisperingDefinition, account);
// After
return openApp(whisperingDefinition, { account });
```

Skills, `apps/skills/src/lib/application.ts`:

```ts
// Before
const app = openApp(skillsDefinition, account);
// After
const app = openApp(skillsDefinition, { account });
```

Application tests replace manually assembled App fixtures such as
`apps/whispering/src/lib/whispering/app.test.ts` with the target pattern:

```ts
const runtime = createMemoryRuntime();
const first = openApp(definition, { runtime });
try {
  const ready = await first.ready;
  if (ready.error !== null) throw ready.error;
  // Exercise the real App handle.
} finally {
  await first.close();
}
const reopened = openApp(definition, { runtime });
// Await readiness, verify committed data, then close before runtime disposal.
```

## Execution waves

1. [x] Prove admission coverage. Trace all document, SQL, blob, and recording
   acquisitions, including evidence scripts. Preserve exact existing local
   claim-key bytes. Audit constructors for owned-storage side effects; the
   shared AI catalog may read/subscribe early. Move standalone SQL evidence
   behind explicit ownership while retaining deliberate raw-backend contention
   fixtures. Prove same-key refusal and different-key independence.
2. [x] Stop using subordinate claims and whole-store blob erasure. Run lifecycle,
   rollback, immutable-publication, source-disposal, and browser contention
   checks before deleting old paths, exports, errors, and obsolete assertions.
   Preserve per-blob delete and non-erasure tests in browser-lifecycle.test.ts.
3. [x] Make the internal resource contract complete, thread an IDBFactory into
   both document opening paths, and fold the separate AI platform selection
   into default runtime assembly. Then change the public options signature and
   migrate all callers together, including Vocab, local-mail, evidence pages,
   and boot-node tests. Reject untyped positional Accounts before side effects;
   verify omitted, definite, and optional Account inference.
4. [x] Land the memory runtime with its first real App test consumer. Reuse
   IndexedDB services over one isolated fake-indexeddb factory per runtime.
   Extract the production SQLite adapter from the worker and use named memdb
   anchors with runtime-unique prefixes and physically closed App connections.
   Preserve account-wide AI sharing and notifications. Test unavailable capture
   and inference, storage reopen, isolation, and disposal.
5. [ ] Migrate remaining App fixtures and module spies while preserving engine
   tests. Run browser/host typechecks and smoke evidence, inspect stale imports
   and docs, and perform an independent review against the complete result.
   Update current package documentation only once implemented. Resolve ADR
   delivery markers and delete this spent spec when the work lands.

One implementer owns `compose.ts`, `open.ts`, the runtime contract, and lifecycle
integration. Bounded parallel tasks may prepare IDB factory threading, SQLite
adapter extraction, and blob erasure removal against that agreed contract.
They must not introduce independent admission or readiness orchestration.

## Lifecycle gates

- Claim reservation for a disposable runtime happens before `openApp` returns.
  Current `Promise.resolve().then(...)` claim scheduling does not satisfy this.
  Validate the definition first; then invoke admission synchronously and contain
  claim errors in readiness. The memory claim reserves before suspension.
- Test immediate runtime disposal after opening, close while admission is
  pending, and a throwing constructor after reservation. Cleanup must await
  admission and release a granted claim even if no document began acquiring.
- Failed readiness makes the handle unusable. It does not certify cleanup.
  Test retirement during opening, close failure, retained admission, and
  supported cleanup retries. A duplicate must never release the incumbent.
- Runtime disposal refuses opening, active, or retained owners; successful
  disposal is idempotent and permanently prevents new opens.
- Two runtimes with identical app/account/database names must remain isolated.
  Same-runtime reopen preserves documents, blobs, SQL, secrets, and AI catalog.
  Closed handles remain unusable. SQL close rolls back unfinished transactions
  and discards temporary tables.
- Inject factories without swapping global `indexedDB` between Apps. Installed
  `idb` also depends on global IDB constructors; contain that dependency and
  prove simultaneous runtimes plus import-time independence from browser globals.

## Evidence and limits

Reviews used App source at `ca6f5efd9db361072eadf6a962cca757d949f5a3`.
Codex ran experiments in a throwaway archive; no production code was changed.

```sh
bun test packages/app/src/app.test.ts packages/app/src/scopes.test.ts packages/blobs/src
```

Baseline: 135 pass, 0 fail, 697 assertions. With only the local App claim,
SQL claim bypassed, and blob operations running directly after key validation:
130 pass, 5 fail, 684 assertions. All App tests passed. The five failures assert
the behaviors proposed for deletion or rewriting:

- `a held Web Lock refuses access without creating a database`
- `erase refuses while the flat publisher owns its shared operation lock`
- `erase refuses a put before its bytes finish converting, while another shared read succeeds`
- `an exclusive erase excludes every ordinary verb without opening a database`
- `a blocked delete reports failure but retains exclusion until the request actually settles`

SQLite WASM 3.53.0-build1 under Bun 1.3.14 supports a named memdb anchor plus
separate physical connections. A probe through the actual SQLite owner and App
wrapper, the extracted production adapter, and production restricted-query
implementation passed reopen, duplicate refusal, retained-handle rejection,
rollback, temporary-table removal, restricted DELETE rejection, and a subsequent
trusted INSERT. Closing all connections erased the backing. Runtime-prefixed
name isolation remains a required implementation test.

These are in-process proofs, not real-browser contention or reload evidence.
During implementation, run two-window refusal and repeated reload/close/reopen
checks, plus host smoke coverage. Unexpected reload refusals require revisiting
claim timing; do not silently add waiting, takeover, or automatic recovery.

The independent Codex review identified readiness/cleanup distinctions, SQL
storage lifetime, standalone evidence callers, and constructor side effects.
Claude reviewed the architecture and experiment results in native session
`8394efde-f429-4ca9-ad09-e7e850cb2595` and recommended proceeding. Codex retained
the narrower storage invariant and the memdb design, and corrected the pending
open/disposal race. Remaining gates belong to implementation, not another
unbounded design round.

## Implementation checkpoint

The complete runtime, options opener, one App admission, memory storage, caller
migration, and App test migration are implemented. All five application
consumer typecheck scripts and the full App typecheck pass. Device and blob
suites pass; Chromium and WebKit prove OPFS exclusion and full App ownership,
including 50 close/reopen cycles and 50 page reloads per browser.

Independent runtime review found incompatible ambient IDB constructors and an
implicit custom-inference fetch fallback. The checkpoint rejects constructor
mixing before mutation and makes omitted custom transports unavailable. The
user has requested a deeper post-commit design review of this boundary before
retiring the spec. That review may replace the guard by removing its cause.

Checkpoint verification: 832 tests passed across App, device, and blob packages;
all eight App TypeScript projects passed. Deeper constructor-boundary review is
the remaining active task before final documentation harvest.
