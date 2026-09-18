# Repository situation and startup verification

> Historical checkpoint: the findings below describe the named review baseline.
> Integration on 2026-09-18 committed the retained evidence and removed the
> unmounted initial-generation experiment. The App API has since moved to
> `open(account)`; claims about dirty files and missing openers below are historical.


Assessment date: 2026-09-17. Baseline HEAD:
`8d629d7354e0d00ce08b604c871f9990dc086c26`, branch
`braden-w/app-schema-derive-export-import`.

Keep the current-library startup contract. The reproduced failures were stale
consumers and fixtures, not evidence that the mounted API needed a historical
initializer. This pass repairs the fixtures and runtime profiles, adds mounted
admission evidence, and corrects the startup documentation. It changes no
production storage algorithm, endpoint, wire format, or authentication policy.
The targeted suites now pass. The repository-wide gate remains red.

No commit, push, deployment, existing-data deletion, or migration was performed.
Tests used generated data and temporary stores. This is a dated assessment;
the linked plans and BACKLOG remain the owners of future outcomes.

## What a person can do today

- Honeycrisp can open Local while signed out, keep Personal notes isolated by
  account, and converge Shared notes between named users of the self-hosted
  Worker. Selection survives reload. A cached library reopens during a Worker
  outage. Switching libraries closes the old App before navigation. The actual
  browser UI fixture passed in this checkout. See
  [the journey](../../apps/honeycrisp/scripts/library.browser.ts) and
  [application composition](../../apps/honeycrisp/src/lib/application.ts).
- A desktop Honeycrisp working copy supports previewed Pull and ordinary Push.
  New files create rows; deleting a file and approving Push permanently deletes
  its row. The 69 checkout tests pass. The desktop filesystem UI was not
  exercised in an installed WebView during this pass. The separate Markdown
  `readArtifact` API remains. See
  [checkout](../../packages/data/src/artifact/checkout.ts).
- Whispering saves immutable app-local audio before creating its recording row,
  can read a saved local key or explicitly stored remote URL, and offers explicit
  upload. Sharing a row does not deliver its audio. These are code and prior
  automated-checkpoint findings; physical capture and real-provider acceptance
  were not rerun here. See
  [the blob plan](../../specs/20260917T113309-flat-extension-bearing-blobs.md),
  [blob package](../../packages/blobs/README.md), and
  [transcription](../../apps/whispering/src/lib/operations/transcribe.ts).
- The application API still opens one fixed Local, Personal, or Shared library.
  `open(account)`, `app.device`, `app.account.personal`, and connection-level
  transcription are proposed shapes, not the current public API. See
  [App](../../packages/app/src/index.ts) and
  [its opener](../../packages/app/src/open.ts).

“Generation” is the identity of one current document history. Ordinary edits
stay in that history. Internal replacement starts a new one.
“Admission” is the server's permission for a connection to send edits from its
history. A connected socket has not necessarily received that permission.
“Retirement” means that history has been replaced: the old App stops accepting
writes, invalidates its cache, and closes. Ordinary startup can then fetch the
replacement. These safeguards exist without a restore product.

## Committed behavior and dirty work

HEAD already contains the current-library route, framed complete capture,
cache installation, authority admission, atomic replacement, durable activation
retry receipts, and retirement fences. The preceding backup cleanup is committed
and recorded in [ADR-0379](../adr/0379-reconstruction-is-an-explicit-destructive-library-operation.md).
The fixtures fixed here are uncommitted changes, so the fresh green results
apply to this checkout, not a claim that HEAD's original suites pass.

At entry there were 23 modified tracked files, 11 untracked status entries, and
no staged changes. The full inventory is below. The initial patch, status, and
all command logs were saved under `/tmp/epicenter-startup-report/`.
Final comparison verified that all 22 other pre-existing tracked diffs are
byte-for-byte unchanged; nothing was staged. The task-only review patch is
`/tmp/epicenter-startup-report/implementation.patch`, based on the entry
checkout rather than HEAD.

The pre-existing startup experiment adds `GENERATIONS_ROUTE.initial`,
`GenerationsLedger.initial()` and an `_initial_generation` table, and makes
`resolveGeneration` request canonical initial bytes. Its intent is sound:
competing devices should select one complete baseline. Its implementation is
on an obsolete, unmounted route family. The current authority already owns
that invariant. Those production edits and the unrelated formatting changes in
`browser.test.ts` remain preserved. The already-dirty foundation test is the
one pre-existing file deliberately revised: its concurrency/offline intent now
runs against the actual current API.

The platform instruction and ADR edits describe runtime package selection and
a constant native grant (ADRs 0402/0403). They run ahead of implementation:
`packages/app/package.json` still selects three `#platform/*` entries by build
condition, and native capability files still grant by window label. The dirty
App README correctly calls runtime selection unbuilt. Do not interpret the new
instruction wording as evidence that those changes shipped. The composition
plan owns their execution; this pass preserves that work.

The untracked session transcripts, transcript review, inline-image benchmark,
and benchmark documents were not repurposed or edited. Four benchmark type
errors belong to that pre-existing untracked benchmark. Its measurements are
not startup acceptance evidence.

## Startup diagnosis and completed cleanup

The actual path is:

```text
application.openPersonal/openShared
  packages/app/src/open.ts: capture account and CURRENT_ROUTE URL
  packages/data/src/store/browser.ts: acquireAppData
    usable current cache -> offline open
    cache miss -> POST initialization candidate
  packages/server/src/store-sync/mount.ts
    authenticate actor, validate app/library, refuse historical migration
  packages/server/src/store-sync/authority.ts
    openCurrentAuthority.ensureCurrent -> frozen snapshot and complete tail
  packages/sync/src/current-download.ts
    frame/decode generation, snapshot position, head, and ordered updates
  browser.ts
    apply every update, reject unresolved dependencies, atomically install cache
  authority.createHub
    admit the current generation before accepting pending edits
```

| Baseline failure | Cause and owner | Change |
| --- | --- | --- |
| Independent device foundation startup | Test used historical discovery against a mount that no longer serves it | Independent process caches now use `acquireAppData` against the real SQLite current authority and shared framing; both retain the same baseline offline |
| Foundation “unadmitted generation” | Missing app/library address; assumed ledger admission and HTTP 404 | Mount test checks addressing/delegation; new real Worker socket test proves retirement without admission or library creation |
| Five Worker failures | Authorization-deadline, generation addressing, large snapshot, and self-host fixtures read a framed body as raw document bytes | Decode with `readCurrentDownload`; retain isolation, revocation, exact snapshot and 8 MiB digest assertions |
| Signed-session socket | Test URL omitted app/library | Use the current address; real signed-token WebSocket and subsequent revocation pass |
| Four deployment profile failures found in final caller sweep | Profiles advertised removed generation endpoints and exercised obsolete addresses | Assert current POST and socket behavior, absent historical routes, owner-override refusal, and hosted database-outage behavior |

No obsolete endpoint was restored. Historical-data refusal still returns 409
and leaves admitted history unchanged. The existing current-open tests still
prove full-tail installation, offline reopen, invalid-response rejection, and
actor/library isolation. Authority and retirement suites still prove rollback,
activation retries, retained-handle fencing, stale-device refusal, and fresh
lineage replacement.

The remaining historical browser API is not silently fixed by these results.
`openDatabase`, `resolveGeneration`, and `createGeneration` still target retired
remote endpoints. Skills references them, but its mounted layout explicitly
rejects boot because it has no Account. The older durable-store browser evidence
also mocks historical discovery. Their mocked tests cannot establish working
startup against today's server. The library ownership plan now owns this
remaining transition; deciding Skills' product purpose precedes choosing its
new App composition. These are incomplete consumers, not a reason to revive
historical routes.

## Trackers that still matter

| Tracker | Assessment and action |
| --- | --- |
| [Library ownership](../../specs/20260909T004225-library-ownership-execution.md) | Current checkpoint added. Keep Bun transport, packaged desktop brokerage/selection, full offline shell acceptance, and historical helper consumers. Earlier restore audit is complete. Historical rollout is conditional, never automatic |
| [App hub/transcription](../../specs/20260912T112824-app-hub-and-whispering-transcription-collapse.md) | Live implementation plan: two scopes, device resources, app destination policy, connection transcription, caller migration. Its current execution contract overrides older row-first/transfer examples |
| [App composition](../../specs/20260912T120000-app-composition-greenfield.md) | App-shape work is superseded by app hub; capability grants, runtime package selection, removal of runtime/settings overrides, and platform modules remain separate live waves. Preserved dirty plan |
| [Flat blobs](../../specs/20260917T113309-flat-extension-bearing-blobs.md) | Implementation and automated integration complete by its recorded evidence; retain only manual/OS acceptance. Corrected two stale archive-recovery statements. No archive, migration or reset obligation was added |
| [Concurrent native capture](../../specs/20260912T122859-concurrent-native-capture.md) | Separate unbuilt feature: current Rust recorder still has one `Option<HeldRecording>`. Saved Stop output is implemented; multiple devices/sessions are not implied by it |
| [Runtime composition](../../specs/20260909T085106-application-runtime-composition.md), [fixed page lifetime](../../specs/20260908T194801-fixed-library-page-lifetime.md), [one active account](../../specs/20260908T214916-one-active-account.md) | Mixed execution history and remaining acceptance. Older API examples, account-only Honeycrisp claims, and recovery obligations are stale. Use current code and the newer ownership/app-hub plans; do not execute these as competing rewrites. Their full acceptance closure was not established here, so they were not deleted |
| [BACKLOG](../../BACKLOG.md) | Preserve hosted erasure before onboarding, Apple sign-in, mail/publishing, signed distribution, and conditional headless/toolkit outcomes. Removed the sync-package rename item: the package now owns routes, framing and transport, is private AGPL, and its former one-file/MIT blockers no longer describe it |
| ADRs [0379](../adr/0379-reconstruction-is-an-explicit-destructive-library-operation.md), [0393](../adr/0393-rows-refer-to-blobs-without-owning-their-lifetime.md), [0394](../adr/0394-a-backup-is-the-library-s-folder-kept-by-the-authority.md), [0395](../adr/0395-restore-is-one-request-that-carries-its-own-safety-copy.md) | Durable product direction reaffirmed by this task: independent bytes, references-only materialization, ordinary Push recovery. Proposed labels are not blockers or proof of missing code. No blanket ADR acceptance changes |

A focused TODO/FIXME scan of App, current store, sync routes, authority,
Honeycrisp data UI and Whispering library code found no markers outside tests.
The actionable evidence is the callers, runtime behavior, and plans above.
The historical spec directory was not converted into a new queue of obligations.

## Fresh verification

Counts are separate runs with overlap; do not add them together.

| Check | Before this pass | Final |
| --- | --- | --- |
| Preserved checkout/startup/authority/hub/retirement/foundation | 117 pass, 2 fail | 119 pass, 0 fail, 536 assertions |
| Checkout subset | 69 pass | 69 pass within preserved run |
| Data/src, current-generation evidence, server/src, Honeycrisp artifact | 715 pass, 1 fail | 716 pass, 0 fail, 2,863 assertions |
| Worker suite | 26 pass, 5 fail | 32 pass, 0 fail; one new mounted admission test |
| Dedicated Worker retirement file | Included | All 3 pass within the Worker run |
| App lifecycle plus sync protocol | Not rerun before edits | 46 pass, 0 fail, 205 assertions |
| Self-host runtime profile | 3 pass, 3 fail | 6 pass, 0 fail |
| Hosted API runtime profile | 5 pass, 1 fail | 6 pass, 0 fail |
| Honeycrisp full browser UI | Historical pass, not a fresh pre-edit run | Pass, temporary local Worker and Chromium |
| App, sync, server, Honeycrisp typechecks | Pass | Pass; Honeycrisp both build conditions and script/fixture leaves |
| API and self-host typechecks | Not rerun before edits | Pass |
| Data main typecheck | 12 diagnostics | Same 12 diagnostic messages; fixture line numbers moved |
| Data DOM leaf | Not rerun before edits | Pass |
| `bun run check` | No fresh pre-edit run | Fails at `lint:ci`: Biome internal range assertion and 374 emitted error annotations; downstream stages did not execute |
| Documentation paths / hygiene | Historical 8 / 58 | Fresh 8 stale paths / 58 ADR-status issues |
| Scoped Biome / `git diff --check` | Not run before edits | No errors; scoped Biome retains 19 warnings and 2 informational diagnostics; diff whitespace check passes |

The Data diagnostics are four `string | undefined` errors in the untracked
inline-image benchmark, plus missing DOM types and resulting implicit-any
errors in the browser ownership fixture, browser storage, and IDB adapter.
The main config excludes browser files but imports can pull them back in.
The changed fixture has the same diagnostic kinds as the task-start fixture.
Fix ownership of those typecheck leaves separately; do not hide errors by
changing the startup contract. Other Data browser evidence leaves were not
rerun in this pass.

The root lint result includes ignored/untracked-looking local `.context` HTML
and bundled browser evidence as well as real source diagnostics. Its count is
an observed output, not a count of distinct production bugs. No claim is made
that the whole-repository failure set is unchanged: the full gate did not run
before this pass. The emitted paths are outside this pass's changed TypeScript.

Reproduction commands (repository root):

```sh
bun test packages/data/src/artifact/checkout.test.ts packages/data/src/store/current-open.test.ts packages/data/src/store/store-retirement.test.ts packages/data/evidence/current-generation/authority.test.ts packages/data/evidence/current-generation/hub.test.ts packages/server/evidence/library-ownership/foundation.test.ts
bun test packages/data/src packages/data/evidence/current-generation packages/server/src apps/honeycrisp/src/lib/data.artifact.test.ts
bun run --cwd packages/server test:workers
bun test packages/sync/src packages/app/src/app.test.ts
bun test apps/self-host/runtime-profile.test.ts
bun test apps/api/runtime-profile.test.ts
bun apps/honeycrisp/scripts/library.browser.ts
bun run --filter @epicenter/data --filter @epicenter/server --filter @epicenter/app --filter @epicenter/sync --filter @epicenter/honeycrisp typecheck
bun run --filter @epicenter/api --filter @epicenter/self-host typecheck
bun x tsc --noEmit -p packages/data/tsconfig.dom.json
bun run check
bun scripts/check-doc-paths.ts
bun scripts/check-doc-hygiene.ts
```

## CI, deployment, and acceptance limits

Configured CI: [Code quality](../../.github/workflows/ci.format.yml) invokes
`bun run check`, which runs lint, all typechecks, tests, then structure checks
in sequence. Worker tests and the Honeycrisp browser journey are separate
commands, not implied by that script. ADR hygiene is not in the canonical gate.
The workflow's comment about local format checking is stale: the actual root
check script begins with lint. Runtime parity has a separate Docker/Postgres/S3
workflow; it was inspected, not executed here.

Observed hosted CI: `gh run list --repo EpicenterHQ/epicenter --commit
8d629d7354e0d00ce08b604c871f9990dc086c26 --limit 20` returned an empty list.
No run for that exact commit was observed. This is not evidence that all CI is
absent or green, and hosted CI cannot validate these uncommitted edits.

Deployment: not inspected or changed. Local Worker success is not a production
health check. No provider credentials or operator database commands were used.

Still manual: physical microphone capture, installed desktop WebView playback,
real OS save dialogs, authorized real-provider upload/playback/delete,
Windows execution, and abrupt-power-loss durability. Synthetic audio,
cross-compilation, browser automation and ordinary process restarts do not
establish those outcomes. The browser fixture also explicitly does not prove
immediate removal of an already-open socket when a user is removed; the Worker
authorization-deadline tests prove expiry and later admission separately.

## Next actions and judgment

1. Restore a usable canonical gate: triage lint scope/crash and actual source
   errors, then fix Data's evidence typecheck ownership and benchmark diagnostics.
   This is engineering work; no new product decision is needed.
2. Execute the composition plan's capability/runtime-selection checkpoint.
   Code still grants native verbs by label; Honeycrisp/Mail do not match the
   shared native grant, and Vocab sets no host build condition. Those are
   source-grounded integration risks, not installed-runtime failures reproduced
   here. Finish that checkpoint before using desktop acceptance to judge blobs.
3. Complete the manual blob acceptance matrix on named target systems. Keep
   results in the existing blob plan, then delete its spent spec when complete.
4. Before the app-hub migration, decide each app's library presentation and
   creation destination. The framework need not mandate a picker or copy flow.
   The `kv` naming question is deferred; boot cost should be measured before
   adding another settings cache. Native concurrency is an independent feature.
5. Decide what Skills/agent surfaces are for. Then migrate their real consumers
   and the old durable-store evidence, and remove obsolete generation helpers
   and the preserved initial-selection experiment as one reviewed change.
   Do not revive `/generations/initial` or silently erase historical caches.
6. Before external onboarding/distribution, address BACKLOG's hosted erasure
   procedure and signed/notarized macOS delivery. The desktop still specifies
   ad-hoc signing (`signingIdentity: "-"`). Deployed OAuth-row cleanup and npm
   deprecation remain operator/release actions requiring a separate authorized
   session; their current external state was not checked.

Explicitly deferred: backup catalogs, retention, destructive restore endpoints,
automatic blob synchronization, recovery UI, unfinished-capture recovery,
background blob reclamation, headless runners without a concrete user,
and simultaneous Cloud/custom-server accounts. No work item here reopens them.

## Review

Relevant files read for the cumulative startup review:

```text
packages/
|-- app/{README.md,src/open.ts,src/index.ts,src/app.test.ts}
|-- data/
|   |-- README.md
|   |-- src/store/{browser.ts,current-cache.ts,current-open.test.ts,store-retirement.test.ts}
|   |-- src/sync/authority.ts
|   `-- evidence/{library-ownership/device.ts,current-generation/authority.test.ts}
|-- sync/src/{generations-route.ts,current-download.ts,current-download.test.ts}
`-- server/
    |-- README.md
    |-- src/store-sync/{mount.ts,authority.ts,generations.ts}
    |-- src/auth/signed-session-socket.test.ts
    |-- evidence/library-ownership/foundation.test.ts
    `-- workers/{generations,initial-generation,current-retirement,authorization-deadline,large-snapshot,selfhost}.test.ts
apps/
|-- api/runtime-profile.test.ts
|-- self-host/{runtime-profile.test.ts,worker/index.ts}
|-- skills/{src/lib/application.ts,src/routes/+layout.svelte}
`-- honeycrisp/scripts/{library.browser.ts,library-retirement.ts}
```

The mount owns authentication/address validation; the authority owns admission
and replacement; the browser owns complete document validation/cache
publication; the App owns closure and resource release. No new production
wrapper or duplicate invariant was introduced. Shared framing earns its
boundary because both sides parse the same network contract. Prototype
initialization tests remain labeled as prototypes, not deployed evidence.

Review found and corrected the stale deployable profiles beyond the initial
file list. It also corrected the server/data README front doors, which taught
historical generation startup. Remaining historical helpers and proposed
platform instructions are called out rather than claimed complete. Review was
performed locally by the implementing agent; no independent reviewer was run.

## Initial checkout inventory

No staged changes. Status captured before editing:

```text
 M .agents/skills/platform-seams/SKILL.md
 M .agents/skills/services-layer/references/service-organization-platforms.md
 M .agents/skills/tauri/SKILL.md
 M apps/epicenter/AGENTS.md
 M docs/CONTEXT.md
 M docs/adr/0179-an-installed-app-is-an-inert-built-folder-admitted-through-one-static-artifact-boundary.md
 M docs/adr/0183-epicenter-mediates-the-effects-it-owns-and-names-the-rest-unmediated.md
 M docs/adr/0189-home-launches-applications-into-their-own-windows-and-stays-open-behind-them.md
 M docs/adr/0190-a-build-declares-which-epicenter-owns-its-data-not-which-window-it-runs-in.md
 M docs/adr/0246-an-app-is-named-by-its-full-reverse-domain-id-everywhere-including-the-ones-epicenter-ships.md
 M docs/adr/0304-application-persistence-is-runtime-selected-and-scoped-by-its-owning-app.md
 M docs/adr/0365-ai-owns-inference-access-and-applications-own-workflow-selection.md
 M docs/adr/0376-application-authors-declare-data-and-the-opened-app-owns-resources.md
 M docs/adr/0387-the-clipboard-is-a-platform-module-beside-the-app-not-a-capability-on-it.md
 M docs/adr/0391-the-build-selects-every-implementation-and-an-application-declares-only-its-id-and-data.md
 M docs/adr/README.md
 M packages/app/README.md
 M packages/data/src/store/browser.test.ts
 M packages/data/src/store/browser.ts
 M packages/server/evidence/library-ownership/foundation.test.ts
 M packages/server/src/store-sync/generations.ts
 M packages/sync/src/generations-route.ts
 M specs/20260912T120000-app-composition-greenfield.md
?? codex-session-01a08468-fadb-7df1-b106-02f0817f8886.md
?? codex-session-01a09818-1756-7291-bd5b-817145613256.md
?? codex-session-01a09819-f0c2-7a93-a621-aa33f2c21de2.md
?? codex-session-01a0981a-6e37-79d2-b0a8-13a4f2f593a4.md
?? codex-session-01a0a2de-fba7-7320-96b3-7cc29eaa0373.md
?? codex-session-01a0a339-ecc3-7813-bc95-459ff42fb20b.md
?? docs/adr/0402-a-window-label-is-identity-never-authority-and-the-capability-is-a-host-constant.md
?? docs/adr/0403-the-package-selects-its-platform-leaves-at-runtime-and-a-consumers-build-passes-no-condition.md
?? docs/benchmarks/inline-images/
?? docs/transcript-reviews.md
?? packages/data/evidence/bench/inline-images.ts
```
