# Execute Local, Personal, and Shared libraries

Date: 2026-09-09
Status: In Progress

## Current startup checkpoint: 2026-09-17

The mounted current-library path is verified by 119 preserved Bun tests, 32
Worker tests, and the full Honeycrisp browser journey. See the
[situation report](../docs/reports/20260917-startup-and-unfinished-work.md)
for exact commands, baseline comparisons, limits, and the remaining work.
Historical generation discovery is not the current startup contract. The
foundation fixture now runs independent current caches against the real SQLite
authority; Worker evidence owns socket admission and retirement.

Remaining implementation: Bun store transport and removal or migration of the
historical browser helper consumers. Skills still has a deliberately refused
boot and needs a product purpose before its App composition is chosen. The
older durable-store browser fixture also uses historical helpers. The unmounted
`/generations/initial` experiment was removed during integration on 2026-09-18;
do not expose a second startup API. Keep the historical-data migration refusal.

Remaining acceptance: packaged desktop credential brokerage and library
selection, full offline shell loading, and the hardware/provider/OS runs in the
[blob acceptance plan](20260917T113309-flat-extension-bearing-blobs.md).
Cached data reopening during a Worker outage does not prove offline delivery
of the application bundle. Historical rollout is conditional future work,
not permission to migrate or erase anything now. The earlier recovery audit
is complete under ADR-0379; no backup orchestration remains to implement.
The two-scope App and connection transcription belong to the app-hub plan;
platform selection and capabilities belong to the composition plan.

## Whispering integration checkpoint: 2026-09-09

Whispering now selects Local, Personal, or Shared before opening its one App.
Local ignores ambient sign-in. Personal and Shared capture the authenticated
person; switching closes UI producers and the App before document navigation.
Native file transcription reads saved bytes through `app.blobs.get()`, so it
does not reconstruct a Personal path for a Shared recording.

The actual browser UI recorded synthetic speech, sent the saved bytes to a real
native Whisper Tiny engine through an explicitly configured test endpoint,
ran optional Polish through local Ollama, played the audio, and reopened both
transcripts and identical bytes in all three libraries. Package browser evidence
separately covers Alice/Bob Personal isolation, Shared row convergence, capture
cancellation, meter cleanup, playback URL release, and zero Local authority
requests. These tests use temporary Worker state and synthetic microphones.

Real Wry WebView evidence covers explicit native SDK file inference, production
app permissions, CSP, exact model/hint metadata, empty audio, and retired-client
refusal. It does not establish native microphone capture, host blob playback,
or active-capture reload behavior at that checkpoint. No controllable CoreAudio
input fixture was available then. This is dated evidence, not the current
acceptance inventory. Automatic byte transfer, unfinished-capture recovery,
and a backup/restore product are no longer required (ADR-0366, ADR-0393 through
ADR-0395). Explicit hosting and live-session teardown remain separate concerns.

Reproduction and detailed outcomes are maintained in
[the integration checkpoint](20260909T171130-ai-runtime-integration.handoff.md).
This adds attachment and Whispering evidence without completing the wider
ownership objective or changing an ADR's acceptance status.
The integration is committed as runtime `89e2cf28f8`, SDK `fcdf6bfddc`, and
Whispering workflow `6cb62c11d4`. Runtime and recording paths now agree between
HEAD and the working tree; the older isolation notes below describe their earlier
split. The final root typecheck retains only the eight starting Data errors.

## Earlier Honeycrisp checkpoint

Honeycrisp now opens Local, Personal, or Shared through its actual browser UI
against the local self-hosted Worker. Alice and Bob authenticate as themselves,
keep separate Personal notes, and edit the same Shared note. Local needs no
sign-in. Selection survives reload; an established cache opens during a Worker
outage without changing library. Switching awaits App closure before navigation.
This completes the bounded browser checkpoint, not the full ownership objective.

Substantial unrelated app composition, SQLite, AI, and storage changes remain
dirty. Task-start status and tracked diff are in
`/tmp/honeycrisp-library-baseline/{status.txt,tracked.patch}` at `dd4d571165`.
Subsequent unrelated commits and dirty work were preserved. The library code is committed as `3aff50a319`. No deployment, migration, or
real/historical library deletion occurred. Unrelated work remains unstaged.

## Settled construction and lifetime

Public opening methods are `application.openLocal()`,
`application.openPersonal(account)`, and `application.openShared(account)`.
Consumers were updated; there is no compatibility `openAccount` alias.
The private App constructor interprets one explicit choice. There is no public
LibraryBinding manager. Local selection is independent of global sign-in state.

Account remains the authenticated person and owns transport/credential repair.
A credential-free `LibraryReplicaIdentity` records Local, Personal plus actor,
or Shared plus actor for caches, SQL claims, recording, and desktop messages.
The constructor captures the scope once. Shared uses the common remote
application library, but Alice and Bob have separate local replicas and pending
queues. All three use the same application/Yjs format.

An application document owns one App. Ordinary departure flushes UI producers,
closes the App, preserves pending writes, saves selection, and navigates. Confirmed
generation retirement instead fences writes and atomically invalidates the old
cache before closure and reload. The old page does not open its replacement.
Same-owner credential repair preserves the App. Account replacement retires its
transport; Bob cannot submit Alice's pending Shared edits. Full document reload
is a lifetime boundary, not an instruction to erase browser storage.

Desktop credentials stay host-owned. Native IPC and resource paths carry the
explicit replica scope, while host forwarding uses the authenticated person.
The accepted desktop model remains one person/server with per-app choices;
the full desktop selection experience has not been proved in a package.

## Reconciled storage ownership

`packages/server/src/store-sync/mount.ts` mounts one production startup protocol:
POST `/api/libraries/:appId/:library/data/:dataId/current`. The stable
application-library authority owns the current generation, initial snapshot/log,
and generation-bound socket admission. Self-host enables Shared for every
admitted user. Personal storage resolves from the authenticated actor; caller
owner overrides are rejected. Hosted deployments do not enable Shared.

`CurrentAuthority.ensureCurrent` commits the first generation and its state
atomically. Concurrent first openers receive the winning state, never their own
losing seed. Responses include generation and snapshot position; the socket
supplies any tail after that snapshot. The Worker adapter bounds seed input and
binds hibernated sockets to their admitted generation.

Browser acquisition uses a stable actor/app/library IndexedDB address with an
optional generation header. A valid cache opens without contacting the server.
A cache miss downloads and validates the complete canonical state before
publishing the header. Retirement clears header and update rows atomically under
the library claim. Local storage is primary data and is never treated as a
replaceable remote cache.

The prior generations-ledger initializer is not mounted as a competing startup
owner. Its latest-listed-history adoption is not a migration policy. Existing
Personal history causes an explicit migration-required refusal; historical
numbered storage and shared-instance bytes remain untouched. Old low-level
history helpers are not the production opening path. ADR-0385 now describes this
same current-authority transaction, and the restore execution spec shares it.
No production restore endpoint was added.

The earlier blob checkpoint used library-scoped tickets and caches. Current
app-local bytes are shared across the app's libraries, while explicit remote
objects remain account-scoped (ADR-0349, ADR-0372). Personal actors literally named `shared` are handled
by matched routes, not substring guessing. The later Whispering checkpoint proves
capture/read/play/reopen bytes within each browser library. Cross-device attachment
transfer in that old design is historical evidence, not a remaining requirement.

## Earlier library verification

Commands below ran on the working tree with Bun and temporary local data.
Logs for root checks are under `/tmp/honeycrisp-library-baseline/`.

| Command | Result and scope |
| --- | --- |
| `SMOKE_VERBOSE=1 bun apps/honeycrisp/scripts/library.browser.ts` | Pass. Actual Honeycrisp UI, independent Chromium storage, real temporary Worker and virtual passkeys. Operator enrolls Alice/Bob; Personal isolation, Shared editing/convergence, unchanged Personal on return, signed-out Local, remembered selection, cached Worker-outage reopening, App closure before navigation, unauthorized Personal override 403, removal followed by session 401. Concurrent Shared initialization returns identical generation 1, position 1, and bytes. |
| `bun test packages/app/src/app.test.ts packages/app/src/recording.test.ts packages/app/src/index.test.ts packages/server/src/routes/blobs.test.ts packages/data/src/store/current-open.test.ts` | 66 pass, 292 assertions. Includes actual App/auth Account replacement with fake HTTP/WebSocket: Bob submits none of Alice's pending Shared writes. Cache tests use fake IndexedDB; blob scope tests mock storage HTTP. |
| `bun test packages/auth/src` | 137 pass, 562 assertions. Auth repair, identity, transport, and brokerage regression coverage. |
| `bun test packages/data/evidence/current-generation packages/data/src/store/store-retirement.test.ts packages/data/src/store/persistence.test.ts packages/data/src/sync/persistence-scheduling.test.ts` | 57 pass, 304 assertions. Portable generation, retirement, and persistence behavior. |
| `bun test packages/device/src packages/blobs/src packages/app/src/recording/browser.test.ts packages/app/src/recording/desktop.test.ts apps/epicenter/src/device.test.ts apps/epicenter/src/server.test.ts` | 238 pass, 2186 assertions. Resource scope, host forwarding, recording, closure, and reserved-name route regression. |
| `bun x vitest run --config vitest.workers.config.ts` from `packages/server` | 8 files, 31 pass. Real Worker concurrency, admission, expiry, generation retirement, partial pushes, snapshot tail, and Durable Object eviction. Restore activation is test-only. |
| `bun x tsc --noEmit -p workers/tsconfig.json` from `packages/server` | Pass. |
| `bun test packages/server/src/store-sync/browser-dial.test.ts` | 6 pass, 21 assertions. |
| `bun packages/data/evidence/browser/current-cache.ts` | Chromium: 27 native IndexedDB cache checks pass. Isolated browser cache evidence, separate from Honeycrisp UI. |

Honeycrisp's six test files pass in separate Bun processes: 27 tests. Reproduce
with `for file in $(rg --files apps/honeycrisp | rg '\.test\.ts$'); do bun test "$file" || exit; done`. Running
`bun test apps/honeycrisp` together exposes six node-text failures from a leaked
module mock; the isolated node-text file passes. This is not reported as a
passing combined suite. Whispering transcription and recording also require
separate processes because of an existing transcribe mock: 5 and 11 pass.

The original `git diff --check` reported a trailing-whitespace line in Vocab
dictation. The later AI integration removed it while migrating that consumer.

Typechecks pass for app, auth, server, sync, device, blobs, self-host, Vocab,
Whispering, Honeycrisp (browser and Epicenter-host), and Epicenter home. Commands
are `bun run --filter @epicenter/<package> typecheck`, and
`bun run --cwd apps/epicenter typecheck:home` for the host. Data's aggregate
`typecheck` still fails with the same eight browser-global/type inference errors
recorded in the earlier `data-typecheck.log`: RequestInfo, indexedDB, BodyInit,
IDBKeyRange, and inferred names. The final log matches those errors; no claim
of a passing data aggregate check is made.

Native verification from the resource owner: `cargo test --manifest-path
apps/epicenter/src-tauri/Cargo.toml blobs::` passes 13 tests; the same command
with `sqlite::` passes 5, and with `export_types` passes 1. These prove native resource
contracts and binding generation, not an installed desktop experience.

Browser smoke log: `/tmp/honeycrisp-library-smoke.log`. Screenshots:
`/tmp/honeycrisp-shared-bob.png` and `/tmp/honeycrisp-personal-alice.png`.
The Shared screenshot was inspected. The harness stops its processes and removes
temporary test state. “Offline” UI evidence means the Worker is unavailable but
the Vite application shell remains reachable; full offline asset startup was not
proved.

Removal rejects subsequent protected requests. Existing sockets are not claimed
to close immediately on removal: the adapter preserves the ten-minute
authorization deadline and rechecks it on socket traffic/alarm. Worker tests
prove deadline enforcement and eviction behavior, not immediate revocation of
already admitted sockets after operator removal.

## Review and remaining work

Production review found and repaired the host route substring collision, raw
replica object ordering in SQLite dispatch keys, and a missing best-effort
browser persistence request. One independent production reviewer authored the
Worker harness/tests but none of the reviewed production implementation; a fresh
reviewer could not be spawned because the thread agent limit was reached.

Explicit follow-ups: Bun store sync; application-owned library presentation;
packaged desktop brokerage/selection proof; full offline shell loading; and
deliberate historical-data rollout. Compare older microphone evidence with the
saved-BlobId checkpoint before repeating it. Audit existing recovery callers
without introducing automatic blob delivery, capture recovery, or restore UI. Preserve
permanent Account retirement, same-owner credential repair, host credentials,
and the current-generation retirement contract while doing that work.


## Earlier library commit isolation and additional verification

The requested commit was built from the task-start diff and current code, then
verified in `/tmp/honeycrisp-library-stage/checkout`. It leaves the concurrent
constructor consolidation, saved-recording file move, AI migrations, native
recording recovery UI, and archive/restore continuation unstaged. This required
hunk-level staging: the committed constructor retains its prior composition API,
while adding all three library openers. The committed recording implementation
remains under `packages/recorder`; the live working tree carries the corresponding
scope changes under its pending `packages/app` move. App passes its own blob
store to recording in both layouts. Working files were not reset to the index.

A leftover ledger interface still required the competing initializer despite
startup using only history listing. It now requires only `list()` for migration
refusal; no old initializer was added to satisfy the type. Historical initializer
work remains unstaged and unmounted.

Additional checks on the isolated commit snapshot:

- `SMOKE_VERBOSE=1 bun apps/honeycrisp/scripts/library.browser.ts`: pass again.
  Temporary Vite configuration allowed the existing checkout's external
  dependency directory because the verification checkout shared installed
  third-party packages. This allowance was not committed. Application source
  and its workspace dependencies came from the isolated snapshot.
- `bun test packages/app/src/app.test.ts packages/app/src/recording.test.ts packages/app/src/index.test.ts packages/server/src/routes/blobs.test.ts packages/data/src/store/current-open.test.ts`:
  61 pass, 274 assertions. The five runtime-composition tests remain with that
  unstaged work, explaining the difference from the working-tree count above.
- `bun test packages/device/src packages/blobs/src packages/recorder/src/browser.test.ts packages/recorder/src/desktop.test.ts apps/epicenter/src/device.test.ts apps/epicenter/src/server.test.ts`:
  238 pass, 2186 assertions.
- `bun x vitest run --config vitest.workers.config.ts` from `packages/server`:
  31 pass in eight files.
- `bun run --filter @epicenter/app typecheck`, the same command for server,
  recorder, Honeycrisp, and Whispering, and
  `bun run --cwd apps/epicenter typecheck:home`: pass.
- `git diff --cached --check`: pass before the feature commit.

Combining the recorder mock tests with the App Account-replacement test in one
Bun process contaminates its rejection assertion; their stated separate suites
pass. The initial isolated browser attempt failed Vite's filesystem allowance
for shared external dependencies; the rerun above passed with the temporary
allowance. Neither failure is represented as successful application evidence.

Logs are under `/tmp/honeycrisp-library-stage/`. The working-tree AI inventory
check `bun test packages/app/src/native-ai.test.ts packages/app/src/ai.test.ts`
passes 11 tests, 39 assertions. It verifies mocked behavior of separate unfinished
work, not native runtime acceptance. Continue that work with
[the AI/runtime handoff](20260909T171130-ai-runtime-integration.handoff.md).
