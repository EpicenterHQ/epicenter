# Continue the current-generation restore design

Continue work in `/Users/braden/conductor/workspaces/epicenter/yamoussoukro`.
Read `AGENTS.md`, then
[the implementation spec](20260909T010040-current-generation-restore.md) and
[ADR-0379](../docs/adr/0379-reconstruction-is-an-explicit-destructive-library-operation.md).
The native Bun storage harness has been replaced. Read the portable authority
checkpoint in the spec, `packages/data/src/sync/authority.ts`,
`packages/data/src/sync/hub.ts`, and the behavioral tests under
`packages/data/evidence/current-generation/`. Raw activation remains unmounted.
The authority owns one current number, transaction-local log SQL, historical
request-bound receipts, and one retained current hub. `createHub` returns a Result;
failed admission must never expose an uncached hub that could later become usable
and split the relay. Bound log handles keep their generation for their lifetime.

The browser storage checkpoint is also implemented and independently reviewed.
`packages/data/src/store/current-cache.ts` owns the optional generation header,
atomic installation, and synchronous discard fence. It shares the append-sized
update engine in `idb-updates.ts` with the deployed browser backing. Native
Chromium and WebKit proofs each pass 27 checks. This establishes storage behavior,
not the complete native-browser App claim and reload loop.

Wire admission and App retirement ordering are implemented. A socket waits for
`admitted` before sending its outbox. `retired` stops its driver and reports one
lifecycle event, even if host socket teardown throws. Store fences and discards
pending persistence before exposing that event. App close retains the library
claim through failed invalidation; explicit retry permits eventual close. Page
departure stops producers, awaits invalidation, closes App, then reloads. An
unsupported deployed backing fails closed because current cache/bootstrap is
still unmounted. Keep ordinary close's flush promise separate from discard.

The unmounted structural archive is `packages/data/src/artifact/archive.ts` with
adjacent tests. It preserves stored roots, nested types, formatting, unknown
values, settings, and referenced blob bytes/MIME types, then authors and checks a
fresh lineage. Version 1 refuses unsupported versions and unrepresentable state.
Its conservative BlobId recognition includes text and URLs: an ordinary mention
of a missing blob can refuse capture. This limitation needs product acceptance.
Durable backup write/read-back, destination blob installation, and deliberate
activation orchestration remain unimplemented.

Final review accepted three repaired regressions: socket-close failure cannot
skip the backing fence; BlobIds split across formatted runs require their blobs;
and Whispering cleanup remains retryable after component unmount. VAD retains
ownership on failed destruction while stopping microphone tracks. App retirement
also starts recorder closure before cache invalidation finishes.

Verified checkpoint: 208 data/sync/archive/departure tests (1,244 assertions),
11 recorder/producer tests (41 assertions), and two App retirement tests
(10 assertions). Native cache proof passes 27 checks per browser. App typecheck
passes, as does Recorder; data typecheck retains eight baseline browser-global
diagnostics. Whispering and App-shell Svelte checks still fail in auth/SQL fixture
integration and an inference-picker test. The spec records their scope.
The full App suite currently fails because its old bootstrap fixtures return
JSON where the concurrent new path expects a Yjs snapshot; later tests cascade
through unreleased test claims. Full workerd initialization/connection failures
also remain unresolved. See the spec for commands and proof scope.

Commit verification later isolated the staged source from concurrent changes:
all 36 App tests and its typecheck pass, along with 195 sync/lifecycle tests,
11 recorder tests, and 13 archive tests. The native cache again passed 27 checks
per browser. The combined-tree failures above therefore must not be attributed
to the isolated restore commit.

App retirement wiring was staged against the committed application composition.
Another task's lazy Whispering bootstrap remains in the working tree. Preserve
its retirement wiring and readiness cleanup when committing that refactor;
this checkpoint does not absorb its other application/auth changes.

Another active task began editing `packages/server/src/store-sync/` and the
first-generation bootstrap path during this execution. It added ledger-backed
initialization and admission checks. Server replacement is paused pending the
user's ownership decision; do not overwrite that work. The current-generation
server adapter proposal was backed out. The server still mounts independently
writable generations. Existing-history rollout is a separate unanswered question;
no deployment or deletion is authorized.

Work toward the full spec and report the proof still missing. Do not describe
these unmounted checkpoints as a shipped restore feature.

The user settled this product contract:

- One current numeric generation per synchronized library at a stable address.
- Ordinary folding handles maintenance; immutable archives provide recovery;
  restore reconstructs application data into a fresh Yjs lineage.
- The authority rejects retired generations. A stale device discards ALL of its
  unsynchronized work, invalidates its persisted IndexedDB replica, closes the
  App, and performs a full page reload. No picker or stranded-work recovery.
- The next page uses normal startup: valid generation header and updates means
  open locally, including offline; absent header means download current. There
  is no persisted `held/rejoining` discriminator or old-page replacement fetch.

Two independent reviews support the ownership model. One stable library authority
must own the current number, log, and socket admission; a pointer beside separate
writable generation authorities leaves distributed fencing races. The browser
backing must fence old writes before atomic invalidation, keeping the library
claim through cleanup. Ordinary close currently flushes pending writes and is
not a sufficient discard operation. Bare reload would reopen the retired cache.

Production still uses independently writable numbered generations. The portable
owner proves atomic first creation, snapshot-plus-tail capture, conditional
activation, durable request-bound receipts, and retired read/write refusal.
Private raw log operations now run inside their owner's transaction. The
replacement deletes no other owner's tables and uses no nested transactions or
Result-to-throw bridge. Hub retirement also fences outbound chunks already in
memory, queued replies, partial submissions, and retained old references.

The independent review found and repaired a lost storage-failure refusal. A
history-free refusal remains sendable when storage admission fails, while old
membership is still permanently fenced on retirement. Refused partial submissions
are forgotten. The same review removed a generation-indexed hub registry and
required failed hub creation to return no hub. Both fixes have regression tests.

Evidence already exists in `docs/benchmarks/yjs-root-rotation/` and
`packages/data/src/__benchmarks__/`. All experiments use `@y/y` 14.0.0-rc.24.
The checkout/root-replacement suites passed 74 tests with 219 assertions, and
the data package typecheck passed at that earlier checkpoint. Focused authority/hub and browser-backing typechecks pass. Full-package diagnostics
must be compared to the captured task baseline and concurrent work; see the spec.
Native browser storage interruption has been proved, but deployed-server
activation and the complete application restore loop have not.
Smaller body updates and byte-aware folding are separate
follow-ups; the benchmarks do not justify automatic document replacement.

The worktree contains extensive unrelated changes. Inspect `git status` and
focused diffs; do not reset or absorb other work. This conversation owns ADR-0379,
these continuation documents, the root-rotation/checkout benchmark files and
reports, the benchmark script addition in `packages/data/package.json`, and the
0379 index row. This execution also owns the authority/hub changes, current-generation tests,
new browser cache and shared update engine, and native browser cache proof.
This execution also owns wire controls, store/App retirement, shared page
departure, app producer cleanup, and the unmounted structural archive. Read their
focused diffs carefully because some files also contain other tasks' edits.
The direction review corrected one misleading adoption comment in
`packages/server/src/store-sync/authority.ts`. Its runtime initialization changes
belong to the other task; do not absorb them into this checkpoint.
Other edits to the ADR index or package files may be unrelated.
No commits or deployments were requested. Do not erase existing device or remote
libraries to make tests pass. Existing-history rollout needs a separate grounded
decision; the user chose discard of retired pending work, not arbitrary destruction
of independently writable historical libraries during migration.

Use the spec's acceptance matrix. Prioritize atomic ensure-current, conditional
restore with retry receipts, old-socket rejection, paused persistence across
retirement, and interrupted IDB invalidation/install. Add real-browser proof for
the browser lifecycle. Run appropriate affected-package tests and typechecks,
then a design review at a meaningful structural checkpoint. Consult Claude only
if the user explicitly asks in the continuation. Done for a first slice means a
reviewable diff with passing focused invariants and an updated spec showing what
remains; do not represent a private harness as a shipped restore feature.
