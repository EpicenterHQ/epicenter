# One active account per host

**Date:** 2026-09-08
**Status:** In Progress
**Owner:** The executing agent owns implementation, integration and verification.
**Design:** [ADR-0374](../docs/adr/0374-the-host-selects-one-account-and-replacement-restarts-its-applications.md)
**Execution prompt:** [Fresh-session handoff](20260908T214916-one-active-account.handoff.md)

## One sentence

A stock Epicenter host offers Cloud sign-in by default and one custom-server URL/token choice, keeps one active Account for its running applications, and applies replacement only through closure and restart.

## Start here

The user chose one active account, not simultaneous Cloud and custom-server
slots. Self-hosting must work in the stock desktop installation. Rebuilding the
host to change servers was considered and rejected. The current code already
supports much of this behavior; verify it and collapse duplication rather than
reimplementing selection as a new framework.

The target is one host-owned sign-in choice with safe persistence and restart,
no running App retargeting, working token reentry, and a small observable auth
state. Server selection cannot be deleted wholesale. Browser apps retain the
analogous document-owned selection and full-navigation boundary.

Read target, safety matrix and waves first. The occurrence map is a launch point,
not a file whitelist. Use `spec-execution` for checkpoints and independent
`design-review` after substantive ownership/API changes. Reconsider remaining
waves when a stronger invariant eliminates work.

## Baseline and ownership

Execution baseline captured on 2026-09-08 at the planning HEAD as a sealed
source snapshot outside the repository. Existing working changes remain owned
by their original tasks. No commits are authorized.

Execution baseline: 165 tests pass with 647 assertions across 18 files. The
documentation hygiene baseline reports 34 existing issues. A full baseline
typecheck is running, with output saved beside the snapshot.

Execution checkpoints:

1. Establish destination/credential restoration and recovery, with an independent
   ownership review before caller migration.
2. Complete browser and native sign-in selection, token reentry, forced-fresh
   handoff, and no-library departure integration; review the cumulative behavior.
3. Remove inactive auth contracts and capability guessing across consumers,
   then run integration, build, smoke, and documentation checks.

Later checkpoints remain provisional until the preceding review resolves.

Planning checkout: `/Users/braden/conductor/workspaces/epicenter/yamoussoukro`.
Planning HEAD: `2dee4a2cbea98c02f5d22bff7a6a25a9a7929def` on
`braden-w/app-schema-derive-export-import`.

Extensive unrelated tracked/untracked work exists, including auth cancellation,
desktop credential ownership, App bootstraps, inference and native recording.
Capture the live diffs and relevant untracked files before implementation. Do
not reset, stash, overwrite or commit another task's work. A HEAD-only worktree
omits current implementation evidence; reconcile ownership before isolating.

This conversation created the ADR and index entry, spec and handoff. It changed
no runtime code. The earlier build-fixed drafts were rewritten after the user
clarified stock-desktop self-hosting; do not restore their deletion mandates.

Planning verification passed 165 tests across 18 files, with 647 assertions:

```sh
bun test packages/auth/src apps/epicenter/src/desktop-auth-authority.test.ts packages/app-shell/src/boot-screens/departure.test.ts packages/app-shell/src/boot-screens/desktop-close.test.ts
```

No builds, typechecks, browser smokes or packaged native checks were completed
by planning. Capture your own execution baseline and attribute regressions
against it, including dirty changes, rather than against HEAD alone.

The final planning review reproduced a missing regression with a local fixture:
`review.auth.server = 'broken'` plus a valid cached Cloud credential causes the
current browser client to publish that Cloud Account without a request. The
existing malformed-selector test has no cached Cloud credential and misses this
fallback. Implementation must fix and test it; the 165-test baseline does not
establish safe selection recovery. The documentation hygiene check reports 34
issues elsewhere, with no finding naming these planning files or ADR-0374.

## Target and ownership

| Surface | Responsibility |
| --- | --- |
| Host sign-in | Cloud default; alternative custom origin plus token; one selected destination |
| Saved selection and credential | One next-startup choice, scoped by auth method and origin |
| Running host | One captured boot Account; old windows never receive its successor |
| App window | Uses captured brokered Account; no server credential or independent selection |
| Browser app document | Equivalent document-owned selection and auth lifetime |
| Auth core | Verification, cancellation, ordered persistence, refusal/recovery and retirement |
| App departure | Stop producers, await physical close, then permit identity mutation and restart |
| Store sync | Actual connection status and progress |

Cloud is the initial default, not an instruction to discard a returning user's
instance choice. Signing out from an instance can retain its selected origin
with no credential so reentry does not require typing the address again. Do not
introduce a saved-server list, multiple native credential slots, or a per-app
account router. Existing browser origin-scoped credential keys need not be
migrated into an account wallet or destructively swept to enforce one active
runtime Account.

This cardinality applies per host process or browser document. Browser tabs
share app-scoped selection storage but own separate captured Accounts. A storage
change in another tab affects the next document, never retargets a live App,
and does not introduce a cross-tab departure coordinator. Reconstruct the Account
after navigation; do not persist and restore closed Apps, departure phases, or
pending sign-in operations as an application-session state machine.

Home Settings/sign-in presents Cloud sign-in and an alternative custom-server
form. Selected-instance UI supports token reentry and read-only current-origin
context. Use the actual supported action or selected method, not an authority
string or probing whether routes exist. Home currently lacks an auth-state
consumer: provide only the secret-free facts/actions it needs through its host
boundary. Child windows must never receive saved credentials.

The implementer chooses final action names and constructor shapes based on real
callers. Prefer one coherent selection owner over spreading policy among UI,
auth wrappers and storage adapters. Preserve platform differences: synchronous
browser storage rollback and native queued writes/relaunch need different code.
Do not hide them behind a universal controller with a callback for every step.

### Replacement and cancellation

```text
one sign-in choice
  -> prepare departure and close affected Apps
  -> verify instance candidate / acquire credential when available
  -> retire old Account and drain its credential writes
  -> persist next startup selection and credential
  -> full navigation or host relaunch
  -> newly opened Apps capture the new Account
```

The existing return to Cloud is a valid two-stage path: `useHostedServer` and
`selectHosted` save Cloud as the next destination and replace the runtime before
Cloud sign-in. Permit that sequence. If Cloud authentication is needed, use a
no-library sign-in surface, then the ordinary callback navigation or native
relaunch. Do not briefly open Whispering's local App between choosing Cloud and
signing in. An explicit destination choice may precede credential acquisition;
publishing its Account still requires the normal verified/restored credential
rules. Test this route separately from verified instance enrollment.

“One managed action” means no required manual logout or source edits. It does
not promise exactly one navigation or restart for the whole handoff. Do not add
a dormant second auth owner or generic staging controller merely to reduce
navigation count.

Candidate verification may happen earlier if isolated from active identity and
persistence; the existing no-library selection screen is acceptable. Preserve
the strict boundary: close succeeds before credential mutation can retire or
replace the Account used by current Apps. Block admission of new app windows
while the host is departing. Duplicate actions share or supersede one explicit
attempt; stale completions cannot publish a newer selection.

A failure before retirement may leave the captured Account valid. Once retired,
restoring an old saved selection cannot revive that Account or its closed Apps.
Recovery requires a fresh document/process even when returning to the same
person and server. Failed relaunch must never give old windows the new Account.
An active recording may refuse closure before teardown; a terminal close failure
prevents replacement and cannot be bypassed by retrying navigation.

Do not require a user to manually log out before changing servers. One action
owns the necessary sequence. Removing a separate preparation/cancel API is only
an improvement if its close barrier and recovery guarantees remain owned.

### Credentials and reauthentication

Account identity and credential value are different lifetimes. Preserve
`{ authorityId, principalId }`, Cloud's `epicenter-api` bytes, and the existing
instance normalized-origin encoding. `baseURL` remains the network destination.
Independent instances returning `instance` must retain distinct data, blobs,
SQLite and claim identities. Selection never migrates or uploads old data.

Preserve the core persisted payload `{ token, principalId }`. Scope its storage
adapter to auth method and canonical origin. The native selected-server record
is now legitimate startup input, but destination and credential must be restored
as one coherent choice. Never combine a saved bearer with a separately changed
`EPICENTER_API_URL`. Missing/corrupt/mismatched/unscoped credentials cannot
publish cached identity or make requests, including revocation against the wrong
server. Do not guess legacy ownership from the current environment. Preserve
local data and document any one-time reauthentication needed for an unsafe old
cell. Preserve existing matching browser keys where their meaning remains valid.

Distinguish selection parsing from credential parsing:

| Startup selection | Restoration |
| --- | --- |
| Absent | Cloud default; restore only a correctly scoped Cloud credential |
| Valid instance origin | Restore only that instance's matching credential, or offer token entry |
| Invalid/malformed saved choice | Deliberate no-library recovery with no cached fallback Account |

In particular, an invalid instance selector plus a surviving Cloud credential
must not become a signed-in Cloud session. Apply the same rule to malformed
native selection envelopes. Keep safe data/credential cells; validation failure
is not permission to erase them. This can be a startup recovery result and does
not require another global reactive state store.

For custom-server enrollment, the UI supplies origin and token to the selection
owner. For token reentry on the already selected instance, origin comes from
that selection. Both current `createInstanceAuth` production callers supply
throw-only `requestToken` callbacks while `connectInstance` performs actual
verification. Choose one real enrollment/reentry path; do not delete the working
form or preserve a callable sign-in method that only throws. Verification,
persistence and publication stay inside one cancellation generation.

Current policy, verified in `packages/server/src/auth/session-policy.ts` and
auth implementation/tests:

| Event | Behavior |
| --- | --- |
| Cloud session activity | 30-day sliding expiry, renewal eligible after one day; no client refresh-token exchange |
| Ordinary Cloud renewal | Same account, no App close or host restart |
| Expired/revoked Cloud credential | Access refused and reauthentication offered; no new library selected |
| Instance credential | Static operator token, no automatic expiry; operator rotation invalidates old holders |
| Core same-person uninterrupted reauth | Preserve strict Account identity; do not sign out first |
| Different person or sign-out followed by sign-in | Retire old Account permanently; use a new runtime before new App |
| Server outage | Preserve cached identity; refuse network access without selecting a fallback |
| Sensitive Cloud account action | Requires recent authentication, currently 600 seconds; routine renewal does not reset authentication age |

Keep the existing visible auth flow: departure to a no-library sign-in screen,
or native close-and-relaunch. Do not promise an App survives browser redirects.
Core Account preservation and actual UI navigation are separate test cases.
Native child brokers currently rely on relaunch after successful sign-in; do
not invent a live recovery protocol as a prerequisite to this cleanup.

Trace `reauthenticate: true` through each exposed path into the real handoff.
A flag dropped by a native broker or route is not supported. Preserve forced
fresh sign-in and expected-principal checks for management. Callbacks open no
App and always leave after successful completion, including same-person cases.

Cloud sign-out preserves bounded best-effort remote revocation of old and orphan
sessions. Instance disconnect forgets locally and never revokes via Cloud.
Retirement aborts HTTP and response streams and closes sockets. Late requests
cannot borrow a successor credential. Caller cancellation does not cancel
shared verification needed by another request.

### Authentication and service availability

Successful `/api/session` verification proves credential ownership, not that
every application service is available. The self-host Worker supports store
sync; the Bun reference does not. Use the Worker for the real self-host sync
acceptance test. Do not expand this cleanup into implementing a Bun sync backend.

Both reference runtimes expose inference/transcription surfaces subject to
operator configuration. Missing provider keys can produce 503 after successful
sign-in. Preserve instance service use and meaningful operation errors; do not
label a service ready solely because an Account exists. Instances have no Cloud
billing or account-management UI. Fix relevant signed-in-equals-ready copy and
Cloud-only links without adding a capability registry or discovery protocol.

## Grounded collapses and retained work

| Candidate | Decision |
| --- | --- |
| Auth `Connection`, `ConnectionStatus`, no-op subscriptions, desktop boot status | Delete: session reports constant connected; desktop copies it |
| `fromAuth` connection subscriber and sign-in busy branch | Delete; retain auth-state observation and real action pending state |
| Repeated hosted authority configuration | Move ownership to coherent hosted construction; remove invalid raw-origin authority fallback |
| UI `authorityId === 'epicenter-api'` and client-type capability guessing | Replace with actual selected auth actions; no general capability registry |
| Server selector and next-startup persistence | Retain and simplify: stock self-hosting needs them |
| `prepared`, `preparing`, `resuming`, `bootStorageRetired`, `recoverConnection` | Trace each guarantee; consolidate ownership before deleting any |
| Candidate verification and selection rollback | Retain required guarantees; avoid duplicate temporary auth owners |
| Throw-only instance launcher | Replace with an actual token path or narrow the exposed contract |
| `verifyInstanceToken` | Retain only if candidate selection still needs it independently of credential installation |
| Browser versus native storage handling | Retain real synchronous/asynchronous boundary differences |
| Auth-state observers and departure | Retain refusal, recovery and unexpected retirement; never open replacement Apps |
| App-specific server configuration in hosted WebViews | Remove; the host owns their selected destination |

## Occurrence hunt

Start with actual sources; diagrams and old ADR alternatives are not exports.

| Area | Starting files |
| --- | --- |
| App auth | Whispering/Honeycrisp `src/lib/platform/auth.browser.ts` and `auth.epicenter-host.ts`; Vocab `src/lib/auth.ts`; app auth adapters and callbacks |
| Auth core | `packages/auth/src/{browser-auth,create-session-auth,hosted-browser-redirect-auth,desktop-broker-auth,auth-contract,instance-server,persisted-auth-storage,account-management,index}.ts`; `svelte/auth.svelte.ts` |
| Host | `apps/epicenter/src/{desktop-auth-authority,routes,server,sidecar-runtime,main}.ts`; `ui/Settings.svelte` |
| Native | `src-tauri/src/{keyring_storage,lib}.rs`; URL opening, boot frames, capabilities, generated bindings |
| Shared UI | `packages/app-shell/src/boot-screens/{app-boot.svelte,server-connection.svelte,sign-in-screen.svelte,connection-screen-context.ts,departure.ts}`; account popover and sign-in panel |
| App-specific UI | Whispering account settings and `TranscriptionRuntimeConfig.svelte`; each bootstrap and callback route |
| Cloud dashboard | `apps/api/ui/src/lib/platform/auth.ts`, dashboard layout and account-management actions |
| Configuration/build | `packages/constants/src/{apps,vite}.ts`, app Vite configs, desktop sidecar build and native URL allowlist |
| Durable identity | `packages/principal`, `data`, `blobs`, `device`, `recorder`; native blob/recording code; inference account keys |
| Public/documented surface | Package/barrel exports, route constants, tests, smokes, READMEs and relevant ADRs |

Run from the repository root:

```sh
rg -n 'createBrowserAuth|createHostedBrowserRedirectAuth|createInstanceAuth|normalizeInstanceServer|verifyInstanceToken|authorityId|authority_id|epicenter-api|EPICENTER_API_URL|HOSTED_AUTH_ORIGIN' apps packages
rg -n 'selectedServer|isBrowserAuth|connectInstance|useHostedServer|selectHosted|selectCell|prepareConnection|cancelConnection|bootStorageRetired|recoverConnection|ACCOUNT_.*(CONNECT|HOSTED)|getConnectionScreen|provideConnectionScreen|[?]connect' apps packages
rg -n 'ConnectionStatus|connection[.]status|connection[.]onChange|onStateChange|fromAuth|reauthenticate|requestToken|authCell|auth_cell|storeAuth|read_auth_cell|write_auth_cell' apps packages
rg -n 'server switching|server selection|fixed.deployment|fixed.server|EPICENTER_API_URL' docs specs apps packages --glob '*.md'
```

Classify each occurrence as delete, replace or retain with a concrete guarantee.
Include imports/exports, indexes, tests, generated contracts and human-facing
strings. Do not delete legitimate server selection to obtain zero grep results.
Store sync, inference and Home event-stream connection status are distinct from
the inactive auth contract. Historical ADR alternatives can remain explicitly
historical. Reconfirm paths because concurrent composition work is active.

## Implementation waves

### 1. Reconstruct and verify the existing owner

- [ ] Capture live baseline and occurrence ledger.
- [ ] Trace full Cloud sign-in, custom selection, token reentry, cancellation,
  persistence failure and relaunch paths across UI, Bun and Rust.
- [ ] Confirm scoped restoration before cached Account construction; repair
  unsafe origin/credential pairing without introducing build-fixed configuration.
- [ ] Distinguish missing selection from malformed selection, including a corrupt
  browser selector with cached Cloud credentials and malformed native envelopes.
- [ ] Establish missing behavioral tests and independently review the proposed
  ownership collapse before migrating callers.

### 2. Consolidate sign-in and replacement

- [ ] Implement one active selection with Cloud default and custom URL/token.
- [ ] Provide real initial enrollment and token reentry; preserve cancellation,
  close barriers, queued writes and post-retirement recovery.
- [ ] Update browser, native, dashboard and app UI callers together. Preserve
  same-origin dashboard callback and existing hosted URL-opening restrictions.
- [ ] Prove instance-to-Cloud return through a no-library sign-in surface, without
  imposing a single-restart promise or opening an intermediate local App.
- [ ] Stop importing superseded wrappers, prove the replacement flows, then
  remove old implementations and duplicated routes/actions only where obsolete.
- [ ] Run targeted lifetime and integration checks; independently review the
  cumulative implementation and revise later waves.

### 3. Remove inactive contracts and finish the sweep

- [ ] Delete inactive auth connection status across core, bootstrap, Svelte and UI.
- [ ] Consolidate hosted identity construction and remove UI namespace guessing.
- [ ] Use `radical-options`/`greenfield-clean-breaks` to challenge remaining owners;
  use a focused `collapse-pass` for recurring indirection without real callers.
- [ ] Close the occurrence ledger with evidence for every retained surface.
- [ ] Update auth/self-host docs to explain stock-client sign-in, restart,
  reauthentication and preserved local data. Do not require client rebuilds.

### 4. Validate and retire planning artifacts

- [ ] Run affected typechecks, builds and browser/native smokes; independently
  review the cumulative result and resolve findings.
- [ ] Align ADR-0361's Proposed text with final shared credential ownership.
  Reconcile conflicting accepted ADR-0326 through explicit bounded amendment,
  preserving historical decisions. ADR-0369's fixed App lifetime remains.
- [ ] Update ADR-0374 to match the final shape and name genuinely unbuilt work.
  Do not self-assign acceptance: `docs/adr/README.md` requires explicit user
  authorization even if a general execution skill suggests automatic flipping.
- [ ] Retire the spec/handoff after implementation and evidence are complete,
  with durable decisions recorded. Do not delete unfinished validation obligations.

## Safety and completion matrix

| Scenario | Required result |
| --- | --- |
| Fresh stock installation | Cloud default, custom URL/token available, one active choice |
| Returning instance or signed-out instance | Restore its origin and matching credential, or allow token reentry |
| Corrupt selection with cached Cloud credentials | No fallback Account/library; deliberate recovery preserves existing data and scoped cells |
| Custom-server replacement | Close barrier completes, candidate verified, scoped next choice saved, restart before new App |
| Return from instance to Cloud | Cloud selection may precede sign-in; intermediate auth document opens no library; ordinary completion leaves for new App |
| Mismatched/legacy native cell | No cached identity and no authenticated request or wrong-origin revocation |
| Runtime URL override | Cannot retarget restored credential or active Account; no rebuild required for explicit sign-in selection |
| Core same-person reauth | Strict Account identity preserved; no preliminary sign-out |
| Ordinary Cloud renewal | No App close/restart; expiry extends without resetting authentication age |
| Different principal or sign-out/sign-in | Old Account permanently retired; no App retargeting or local fallback |
| Invalid token, outage, cancellation | No late installation; outage preserves known local identity; rejected token offers reauth |
| Cancellation after retirement | Never revive old Account; recover through new document/process |
| Close refusal/terminal failure | Refusal can retry before teardown; terminal failure cannot mutate identity or navigate |
| Native relaunch/persistence failure | Old windows never obtain replacement Account; writes cannot resurrect old credentials |
| HTTP, response streams, sockets and delayed blobs | Retirement terminates captured work; no foreign-origin forwarding or successor borrowing |
| Callback/fresh sign-in | No App opened; full navigation on completion; forced-fresh intent reaches real handoff |
| Home and app UI | Supported actions reflect selected method without exposing credentials or interpreting namespace strings |
| Reactive behavior | Refusal/recovery/retirement observed; no reactive replacement library or fake connection status |
| Browser tabs and navigation | Another tab's saved choice never retargets a running App; new document reconstructs Account and never revives old departure state |
| Durable identity | Separate instances keep separate stores/blobs/SQL/claims; switch never moves data |
| Instance services | Worker proves sync; missing provider configuration reports service failure without claiming auth failed; Cloud management links absent |
| API collapse | Obsolete exports/callers removed; legitimate retained selection surfaces documented |

## Verification commands and evidence

Repeat the baseline command. Additional existing checks to inspect and adapt:

```sh
bun test apps/epicenter/src/account-transport.test.ts apps/epicenter/src/sidecar-runtime.test.ts
bun test apps/epicenter/scripts/build-sidecar.test.ts
bun test packages/data/src/store/store-blobs.test.ts packages/blobs/src/webview.test.ts packages/app/src/app.test.ts
bun packages/auth/smoke/session-handoff.browser.mjs
bun packages/auth/smoke/instance-connection.browser.mjs
bun packages/auth/smoke/dashboard.browser.mjs
bun packages/app-shell/smoke/app-boot.browser.mjs
bun run --cwd packages/auth typecheck
bun run --cwd packages/constants typecheck
bun run --cwd packages/app-shell typecheck
bun run --cwd apps/whispering typecheck
bun run --cwd apps/honeycrisp typecheck
bun run --cwd apps/vocab typecheck
bun run --cwd apps/epicenter typecheck:home
bun run --cwd apps/api/ui typecheck
```

Read smoke setup requirements; use disposable local servers and credentials.
Preserve the real instance-selection smoke and add token reentry/failure coverage
where absent. Dashboard smoke needs a built API UI. Retain self-host Worker and
recording close-barrier checks when their boundaries change. Earlier auth skill
references to `account-blob-remote.test.ts` point at a missing file here; establish
late-blob Account capture in current owners instead of assuming coverage.

Run full `bun typecheck` once after the final cross-package API change, plus
relevant builds and native checks. Ground external runtime behavior in installed
code/types or official docs before editing it. Regenerate native contracts only
through the repository procedure if they change. Build does not authorize
installation, signing, deployment or publishing. No commits are requested.

Run `bun scripts/check-doc-hygiene.ts`, compare with the captured baseline, and
fix task-created faults without accepting unrelated ADRs or deleting other
agents' specs. Report actual limitations: unit tests alone do not demonstrate
working browser token entry or native restart. Completion includes real Cloud
and custom-server flows, safe lifetime behavior, classified remaining occurrences,
and an independently reviewed implementation.
