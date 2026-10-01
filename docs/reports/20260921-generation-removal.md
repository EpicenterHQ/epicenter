# Generation removal review

Date: 2026-09-21

The recommended contract is [one document per stable data
address](../adr/0417-a-data-address-holds-one-document.md). Remove online
replacement as a capability, then remove the code that exists to coordinate
it. This review changes the decision records; production implementation remains
outstanding.

## Evidence inspected

Source inspection included these files and relevant excerpts. Historical ADR
bodies were read where their metadata did not resolve the decision.

```text
apps/
├── api/README.md, wrangler.jsonc, worker/index.ts, worker/account/README.md
├── self-host/worker/index.ts, wrangler.jsonc
├── sync-lab/worker/index.ts
└── honeycrisp/scripts/app.worker.ts
packages/
├── app/
│   ├── package.json, src/open.ts
│   └── src/data/
│       ├── README.md
│       ├── artifact/checkout.ts
│       ├── store/browser.ts, current-cache.ts, idb-updates.ts
│       ├── store/store.ts, document.ts, log.ts, persistence.ts
│       ├── store/current-open.test.ts
│       └── sync/authority.ts, hub.ts, connection.ts, client.ts, attach.ts, frames.ts
├── app-shell/src/boot-screens/app-boot.svelte
├── server/
│   ├── src/data-scope.ts, principal.ts, index.ts
│   ├── src/store-sync/authority.ts, mount.ts, generations.ts
│   └── workers/current-retirement.test.ts
├── sqlite/package.json, src/bun.ts
└── sync/README.md, src/generations-route.ts, store-route.ts, current-download.ts
docs/adr/
├── README.md
├── 0231, 0272, 0274, 0276, 0281, 0283, 0285, 0286, 0287
├── 0290, 0292, 0293, 0324, 0336, 0337, 0340, 0355, 0367
└── 0379, 0385, 0394, 0395, 0407, 0412, 0414, 0416
specs/20260909T004225-library-ownership-execution.md
scripts/check-doc-hygiene.ts
```

Repository-wide symbol searches covered activation, retirement, authority
constructors, ledger methods, checkout consumers, and App closure. Installed
Yjs source and the Git change introducing admission supplied external-library
and historical evidence.

## ADR findings

| Earlier direction | What changed | Treatment |
| --- | --- | --- |
| 0276 and 0281: numbered, selectable histories | Current startup uses one stable authority; no production replacement caller remains | Amend the current-data generation contract, preserve historical records |
| 0285, 0292, 0324, 0340: generation in opening and address | Current storage is already stable; the number survives in metadata, socket queries, and checkout | Remove the active identity field without renaming storage |
| 0283, 0287, 0293: allocation, publication, erasure | The only production ledger reader checks for admitted historical data before initialization | Retain that refusal; do not infer permission to purge history |
| 0337: generation-bearing checkout baseline | A stable destination no longer identifies which pre-reset state a manifest describes | Remove the field; require a fresh baseline after manual replacement |
| 0379: keep safeguards until a caller audit | Activation callers are fixtures and tests | Rewrite the proposal around lineage-preserving maintenance |
| 0385: atomic first generation | Canonical first initialization survives without a number | Rewrite as the separate bootstrap decision |
| 0394 and 0395: readable-file recovery | Recovery already uses ordinary Push | Remove statements requiring retention of activation and receipts |
| 0407: preserve old bytes and refuse implicit migration | Removing current generations does not settle historical ownership | Preserve unchanged |
| 0412: App retirement and stable addresses | Data-driven retirement goes; generic cancellation and address bytes survive | Add a bounded amendment |

Already superseded 0274, 0286, and 0290 remain historical. The 0231 replacement
proposal and 0272 restore proposal are read through their later amendments,
not used to reintroduce an online restore action. No historical claim that
namespaces were empty is treated as evidence of today's deployment state.

## Current and target ownership

```text
Current
stable data address
  -> current-generation row + snapshot/log + restore receipts
  -> generation-bound authority methods
  -> replaceable hub + per-socket hub map
  -> admitted/retired frames
  -> cache discard + persistence discard
  -> document abort -> App close -> page recovery

Target
stable data address
  -> one snapshot/log authority
  -> one server-owned hub
  -> authenticated socket + cursor
  -> one IndexedDB update backing

App owner -> cancellation, store close, resource release
Operator  -> bears all consequences of out-of-band replacement
```

Suggested internal composition, not a claim about current exports:

```ts
const authority = openSyncAuthority({ sqlite }); // the sole authority constructor
const hub = createSyncHub({ authority });

// HTTP bootstrap: atomic ensure, returning canonical bytes through head.
const capture = authority.ensure(seed);
// Capture: { head, snapshot: { position, bytes }, tail: [{ seq, bytes }] }

// Production upgrade checks initialization and cursor bounds before pushes.
// Generic hub/log use in sync-lab needs no separate checked/unchecked variant.
STORE_SYNC_ROUTE.address(baseURL, { appId, scope: 'personal', dataId, cursor });
```

`ensure` merges the existing `seed` and `ensureCurrent` responsibilities.
`capture` remains complete and fails if no baseline exists. The server adapter
owns production bootstrap ordering. Sync-lab may use the same log and hub
directly; it must not require a second authority implementation or mode flag.
Active sync callers supply a complete app/scope address. The old optional
address fields should not preserve invalid production call shapes.

## Removal map

| Owner | Remove | Preserve |
| --- | --- | --- |
| `sync/authority.ts` | `openCurrentAuthority` as a second implementation, `bind(generation)`, injected generation admission, `prepareActivation`, digest/CAS/receipt machinery, `log.replace`, generation error/types | One SQL transaction owner, canonical initialization, complete capture, append, snapshot coverage, storage failures |
| Server `StoreAuthority` | Generation query parsing and attachment field, `createHub(generation)`, per-socket hub map, unused `deleteStore()` | One hub, per-socket connection/cursor, hibernation reconstruction, authorization deadline/alarm |
| `sync/hub.ts` | `retire`, `notifyRetired`, nullable replaceable lifetime, admission before/after each send | Membership, catch-up, chunk bounds, `dispatchDepth` and queued reentrant delivery; add refusal of `cursor > head` |
| `sync/frames.ts`, `connection.ts`, `attach.ts` | `admitted`/`retired` frames, `onRetired`, retired status, generation fields, admission phase | Attach on socket open, dial timeout, reconnect/backoff, auth refusal, stalled-submission watchdog; never reuse removed opcodes |
| `sync` route/download package | `CURRENT_GENERATION_HEADER`, dead `GENERATIONS_ROUTE`, generation-bearing shapes; move active route constants out of `generations-route.ts` and remove its export | Existing route strings, captured-head header, body framing, completeness validation |
| Browser storage | `current-cache.ts`, header reads/writes, install/discard state machine | `openIdbBacking`, atomic `create`, scratch-document validation, offline replay, one backing for both scopes |
| Store/persistence | Unused `stopSync` surface and `syncStopped` flag, `StoreBacking.discard`, `PersistenceController.discard`, retirement flags, invalidation retry, `isRetired`, `canRetryClose`, reverse document-abort propagation | Disposed-handle errors, final flush, async acquisition cleanup, App cancellation and failed-release retention |
| Address types | `ReplicaDocument` and `ReplicaData`; move the Worker probe shape into its fixture | Structural checkout destination checks |
| Production bootstrap adapter | Generation admission check | Refuse sync upgrade until a baseline snapshot exists; keep this ordering out of the generic hub |
| Checkout | Generation in `CheckoutAddress`, `CheckoutManifest`, parser, serializer, source comparison and adapters | Destination checks and readable files; ADR-0418 separately replaces three-way planning with file-versus-baseline edits |
| Tests/evidence | Replacement-only authority/hub/store tests and Honeycrisp activation harness | Canonical initialization, cold/cache opening, auth, hibernation, outbox/fold, generic producer shutdown and checkout coverage |

The App's abort signal serves AI, blobs, and general cancellation and stays.
The shell's abort listener is removable only if its remaining callers prove
that AppBoot owns every closure it observes. Keep auth-change and back/forward
cache recovery. Do not delete UI cancellation tests merely because their titles
use the word retirement.

The historical ledger is a separate boundary. Production calls `list()` for
the 409 refusal; `allocate`, `admit`, and `holds` have no production callers.
Their fixture callers can move to explicit historical-state setup. Retain the
historical reader and its bindings until disposition is separately resolved.
Dead generation URL builders and the uncalled historical authority-name export
need no preservation just because the stored names still exist.

## Independent review and adjudication

The earlier Codex review traced server callers. Claude Code then applied the
design-review method read-only against the live checkout and reviewed the
follow-up evidence. Both recommended removing generations with out-of-band
replacement outside the synchronization contract. The native consultation completed three times without errors
or permission denials, using `claude-fable-5-1`, session
`7242181e-912a-41f9-9a98-f1b1ce93f526`.

Accepted: one authority plus one host-owned hub; remove both generation control
frames; collapse the cache; keep a stateless cursor bound and a dial deadline;
require fresh checkout baselines after replacement. Retain the rewritten
bootstrap ADR because canonical initialization remains a distinct useful
decision, rather than deleting that guarantee to reduce the record count.

Corrections and limits:

- Removing admission does not remove the need to time out a socket that never
  opens. The submission watchdog starts later.
- The cursor probe below establishes admission and append at the hub boundary.
  It does not establish a complete browser reconnect loop.
- The current browser opener submits an empty seed on a cache miss. Reopening
  an old client is not a restore mechanism. Binary restore is outside the
  proposed contract; this review supplies no reset runbook.
- Generic App cancellation is not generation retirement. Shell listener
  deletion requires its own remaining-caller check.
- No new reset RPC is justified. The uncalled `deleteStore()` is not a verified
  reset implementation. No live authority was erased during this review.

## Deeper ownership review

The third Fable consultation checked the remaining registries and invalidation
paths. Its evidence extended to:

```text
packages/app/src/data/
|-- open.ts
|-- store/handles.ts, memory.ts, store.ts, index.ts
|-- sync/attach.ts, client.ts, connection.ts
`-- artifact/checkout.ts
packages/device/src/app-claim.ts
packages/server/
|-- src/store-sync/generations.ts, mount.ts
`-- workers/replica.ts, e2e.test.ts
apps/sync-lab/ui/main.ts
```

The stronger rule is fixed document and backing ownership for the opened
store's lifetime. Transport cannot erase or replace either. Store `stopSync`
and `syncStopped` belong to the removed retirement choreography. A repository
symbol search found no external caller of that store method, including tests;
the Worker probe has a distinct method with the same name. `ReplicaData` and
`ReplicaDocument` survive as an addressed fixture type with no production opener.
Remove them and correct the checkout comment referring to them. Wiring the
production App handle to checkout still needs an explicit destination because
that handle lacks `baseURL` and `principalId`; this review does not claim that
integration is built.

Keep the `syncEngines` WeakMap and `syncEngineOf` bridge. They associate a public
capability with its internal engine across wrapper objects; they neither track
devices nor invalidate documents. Unlike the source comment's claim, the bridge
is exported through `data/open.ts`. Generic connection callers, sync-lab, and
evidence code use it. Removing it would require a separate API decision.

Keep the Web Lock claim, App cancellation, authorization expiry, socket
membership, and ordinary change listeners. They protect local ownership,
credential lifetime, delivery, and derived views within one document lifetime.
A blanket ban on registries would discard those guarantees.

### Separate cleanup candidates

`attachedStatus` and `registerSyncConnection` can potentially disappear because
the production store already owns its connection. Its `sync.status()` could
read that connection directly; external attachers could read the connection
they hold. This withdraws status forwarding for externally attached stores,
which an existing attach test explicitly promises. Verify Worker and generic
callers before changing that independent API behavior. This is a small follow-up,
not a prerequisite or a new ADR.

The historical ledger constructor executes `CREATE TABLE IF NOT EXISTS` before
`list()`, including when fresh bootstrap checks for history. A read-only guard
may therefore create stored data in the historical namespace. Verify in workerd
or Miniflare whether this sets `hasStoredData`, and whether a no-write lookup
avoids it. If confirmed, avoid table creation on reads and return an empty list
when the table is absent. Keep the list RPC and historical 409 refusal. This
candidate belongs to ADR-0407's disposition boundary and authorizes no purge.

Fable's suggestion to remove the manual reset runbook is accepted. The ADR now
states operator responsibilities without promising a reset implementation,
global proof, or automatic repair. Its cursor check protects an ordinary log
invariant and adds no replacement state. Fable described the stale-cursor probe
as an unbounded-append result; the actual evidence remains only the two joins
and two appends recorded below.

## Verification performed

Three disposable Bun probes used installed dependencies without modifying
production code or persistent application data:

1. Yjs snapshot application: set a value to `before`, capture, change to
   `after`, apply the old capture. The live value remained `after`; loading the
   capture into a fresh document produced `before`.
2. Existing IndexedDB compatibility: `fake-indexeddb` held a current cache with
   generation 7, a baseline at position 4, and one pending append. Opening that
   same database through `openIdbBacking` returned
   `{ updates: 2, outbox: 1, cursor: 4 }`. The unused `header` store required no
   version change or alternate reader. This is a mock IndexedDB probe, not
   browser acceptance evidence.
3. Stale-cursor admission: the real current authority started at head 1. Two
   successive connections each supplied cursor 50 and the same raw push.
   Both joins returned `admitted`; head advanced to 3. A bounds refusal must
   happen before append. The server deliberately treats update bytes as opaque.

`git log -S 'const ADMITTED'` found commit `f2daed4c443dfeb7697daa3118a93e8dae47e642`,
which introduced admission with generation retirement. Its connection diff
changed attachment on socket open to attachment after admission. This supports
removing the extra handshake, not the independent connection deadline.

Cloudflare documents that `deleteAll()` removes SQLite contents and, for
compatibility dates from 2026-02-24, alarms. Both app configurations use
2026-03-06. This establishes storage semantics, not a stopped-producer reset
procedure. See the official [SQLite storage API](https://developers.cloudflare.com/durable-objects/api/sqlite-storage-api/#deleteall).
No workerd reset/abort experiment was run, so no operational sequence is
presented as verified.

Document validation checked local links, unique ADR numbering, punctuation,
and whitespace. `git diff --check` passed. The repository-wide
`bun scripts/check-doc-hygiene.ts` reported 60 findings before these edits and
61 afterward. The sole added finding is the checker's cross-reference/status
warning for ADR-0417; it reports no new numbering fault. Existing ADR statuses
were not changed to silence the check.

## Required implementation evidence

- Concurrent first openers receive the same complete canonical capture across
  authority restart. A failed or incomplete download publishes no usable cache.
- Existing stable caches and server logs reopen with pending edits intact while
  old metadata is ignored. Verify this in a browser and workerd after updating
  both protocol ends.
- An out-of-range cursor produces no append and no local discard. Normal
  disconnect, hibernation, auth expiry, reconnect, and folding still work.
- Checkout omits generation, preserves source checks, and compares ordinary
  edits correctly. Do not build a reset harness or automatic manifest invalidation.
- Recheck generic closure, late acquisition, failed physical release, and
  queued producer cancellation after removing retirement-specific branches.
- Typecheck the affected packages and sync-lab. Run surviving sync/store/Worker
  tests and the Honeycrisp browser journey without its activation leg.
- Search for generation references across app, server, sync, checkout, adapters,
  and fixtures. Remaining matches must belong to historical-data protection,
  opcode reservations, unrelated concepts, or historical documentation.

Connect the single path and verify it before deleting displaced implementations.
Do not leave a selectable old path, compatibility alias, fake generation, or
future-reset hook. Historical storage is the explicit exception; no deployment
or data purge follows from this review.

## Working-copy follow-up

[ADR-0418](../adr/0418-push-translates-file-differences-into-ordinary-edits.md)
records the later decision to submit field-level file differences through the
ordinary replica. Earlier recommendations in this review to preserve three-way
planning are no longer the target. Generation removal remains independent.

Stragglers updated: draft ADRs 0338, 0341, and 0343, materialization ADR 0394, recovery
ADR 0395, ADR 0417, and the index. Accepted 0337 retains its historical body with bounded amendment links. Code, tests, and the data README still
describe implemented behavior; they require an implementation pass, not a prose
claim that the new model already ships. CLI placement, authorization, dirty
Pull, and missing-row policies remain separate decisions.

Remaining implementation stragglers:

| Location | Current behavior to revisit |
| --- | --- |
| `data/artifact/checkout.ts` | `storeChanged`, live-store rendering in `planPush`, `Confirm`, `sameReading`, partial-result baseline carrying, automatic admission of edited missing rows |
| `data/definition/content.ts` | Plain-text body rewrite deletes and reinserts the entire sequence |
| `data/artifact/checkout.test.ts` | Tests pin the old preview, conflict, and partial-result behavior; replace assertions with the new invariant during implementation |
| `apps/epicenter/src/checkout.ts` and server routes | Folder HTTP transport remains until replica and filesystem ownership are decided |
| `data/README.md` | Current API descriptions remain accurate for shipped code; a direction note links the unbuilt decisions |

Recovery evidence is still required: flush failure before baseline advancement,
crash after new-row creation before file rename, baseline-write failure followed
by a remote edit, and concurrent file changes during Push. Repeating an equal
scalar assignment is not sufficient proof of retry safety across these cases.

The follow-up documentation pass passed `git diff --check` and checked local
links in rewritten records. The hygiene script currently reports 62 findings,
including the new depended-on Proposed ADR-0418. No production tests ran because
this pass changes documentation only.
