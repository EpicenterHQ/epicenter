# Runtime lifetime collapse

**Date:** 2026-09-19
**Status:** In Progress
**Owner:** Braden: product choices; Codex: implementation and verification

## One sentence

Epicenter saves during use, changes desktop accounts through process restart,
and ends application sessions through document replacement.

## Outcome and completion

Current code coordinates page cleanup and native window acknowledgements before
changing identity. The target uses the process and document as lifetime owners.
Completion means the close/resume protocol, page-lifetime controller, cleanup
registration, and `Leave` plumbing are gone, with native restart and browser
replacement evidence proving the new boundaries. The architecture proposal is
[ADR-0415](../docs/adr/0415-runtime-replacement-ends-application-sessions.md).

The implementation and maintained replacement evidence are present. The spec
remains active because physical native microphone interruption could not be
verified: CoreAudio failed before capture began. Synthetic browser capture,
real native restart, sidecar termination, immediate window reopening, and
committed-data survival pass. Do not treat synthetic capture as physical-device
acceptance. Rerun the maintained native capture probe when a working input device
is available; delete this spec only after its remaining acceptance work ends.

The checkout contains concurrent auth and shared-data changes. Preserve them;
the task-start dirty baseline is recorded below, independently of current HEAD.

## Product contract

Accepted direction:

- Persist ordinary edits locally during use. Departure does not guarantee that
  every queued write finishes. Previously committed data remains usable.
- A successful desktop sign-in, including same-person reauthentication, starts
  a fresh process. Sign-out clears the next boot's credentials and restarts.
- Cancelling sign-in before its acceptance point leaves working windows open.
- Browser application exits use full navigation. Retirement leads to an inert
  recovery document, not automatic reopening or account substitution.

Accepted warning policy (2026-09-19): one unconditional warning
at explicit account-change initiation. Wording: "Epicenter will
restart when this account change completes. Active recordings and unsaved work
will be discarded." Confirming authorizes that later restart, including work
started while OAuth is pending. No second confirmation on callback completion.
This deliberately needs no cross-window inventory or asynchronous veto.

That wording is desktop-specific. Browser actions warn before replacing the
working document: "Changing accounts will close this page. Active recordings
and unsaved work will be discarded."

The user explicitly authorized discarding an entire active recording or
explicit-save draft after this warning. No per-window veto remains. Ordinary
tab-close draft warnings may remain; forced retirement removes the working UI
and its handler before replacing the document.

## Target ownership

```text
Desktop process
  captured boot Account: can pause or retire, never become another Account
  sign-in attempt: obtains and verifies credentials for the NEXT process
  accepted transition: retires old access, persists next boot, terminates

Application document
  opens one App
  renders its UI
  full departure destroys this document

Persistent storage
  keeps committed data across either lifetime
```

Two paths must remain different:

```text
Sign-in cancelled before acceptance -> keep existing process and credential cell
Sign-in accepted                    -> finish transition or remain retired
```

An accepted transition never rolls back into a working old session. A credential
write failure is an error, not a successful sign-out. A crash after a successful successor write boots the successor. A failed
write may already have changed storage; do not claim which identity a manual
restart will load.

## Task-start grounding

| Owner | Observed behavior | Consequence |
| --- | --- | --- |
| `apps/epicenter/src/desktop-auth-authority.ts` | Captures `account` once but calls mutable `auth.startSignIn`; owns prepare/resume/recovery state | Keep the boot account; replace desktop installation with a next-boot transition |
| `packages/auth/src/create-session-auth.ts` | `install` verifies, persists, mutates an attachment, and publishes it | Browser behavior stays; desktop must not publish a successor |
| `apps/epicenter/src-tauri/src/application-close.rs` | Per-window request, preflight acknowledgement, timeout, then destruction | Delete after restart no longer depends on window acknowledgement |
| `packages/app-shell/src/boot-screens/app-boot.svelte` | Calls `createPageLifetime`, registers cleanup, waits for UI work, renders closing states | Retain opener/rendering; remove departure coordination |
| `packages/app/src/data/store/persistence.ts` | Enqueue starts a flush during use | No new autosave subsystem is required for existing store writes |
| `packages/app/src/platform/documents.ts` | Browser and desktop documents use IndexedDB | SQLite timing is not the measurement for note persistence |
| `apps/epicenter/src-tauri/src/recorder/commands.rs` | Stop and document cleanup share the recorder mutex | Do not add an arbitrary grace timer |
| `apps/epicenter/src/server.ts` | SQLite WebSocket close/error closes its dispatcher | Preserve host cleanup when the document disappears |

The native recorder discards active capture when its document ends. Browser
recording retains chunks in memory until stop. Native saved bytes may exist
before the page inserts the recording row. Those are distinct from a pending
text edit. Mail's saved-query editor is explicitly saved, not continuous autosave.

## Desktop transition

Keep the existing desktop authority as the owner. Its public caller surface
need not expand. It retains account/bootstrap/status, sign-in, cancellation,
sign-out, callback admission, and disposal. Rename only when it removes a real
ambiguity; do not build a parallel auth service.

Implemented desktop sequence:

```text
sign-in
  warning -> begin existing OAuth handoff -> verify returned credential
  cancellation or verification failure: revoke orphan result as appropriate
  acceptance: reserve the sole terminal transition
  dispose old auth owner and fence its Account
  persist verified successor behind already queued old-owner writes
  await bounded old-token revoke
  request native restart

sign-out
  warning -> reserve terminal transition -> retire old Account
  await credential clearing and existing bounded revoke attempt
  request native restart
```

Before acceptance, one attempt owns cancellation and callback state. Concurrent
sign-out and sign-in completion cannot both accept. After acceptance, no cancel
or late callback can restore credentials or clear a newer transition. Preserve
write ordering; late old-account persistence must not erase the successor.

`readApiSession` currently lives in `packages/auth/src/read-api-session.ts` and
is consumed internally by `create-session-auth.ts`; it is not an established
public export. Share the narrow verification operation at its owning package if
needed. Do not duplicate its network semantics or add a general installation
policy framework merely for this host.

Keep the current bounded revocation behavior. A dying process cannot reliably
complete fire-and-forget revocation. Report a local transition accurately without
claiming the remote token was revoked. A hung server can still account for the
existing bounded wait; fast-close removes application drains, not that auth work.

Keep old Account transport fencing and broker refusal if restart does not happen.
Eliminate the close-acknowledgement prerequisite on native relaunch only when
the accepted transition already retires access. A terminal auth transition gate
is distinct from a registry asking individual windows whether they may close.

The server currently injects `bootSnapshot` into cached page HTML. After an
accepted transition, serve a static restart-required document for working-page
requests. If restart fails, reloading or reopening a window must not open an App
using stale bootstrap identity. Keep this gate with the host's terminal state.

The implemented simplification disposes the old auth owner before directly
writing next-boot credentials. Verification-mismatch writes already queued by
that owner precede the new write; later callbacks fail its ownership check.
Tests cover both rejected old writes and writes that mutate storage before
rejecting. Writing before disposal was not adopted. No runtime mode or rollback
path remains.

## Application document

AppBoot remains the mount-time opener. Its actual `auth`, `definition`,
`runtime`, destination, naming, and rendering inputs have separate uses; do not
pack them into a new configuration object just to reduce the prop count.

Remove the `Leave` snippet argument and cleanup registration. Preserve the
captured Account argument initially; removing it is a separate caller audit.
Ordinary same-App views may still use client-side routing.

The recovery URL marker is `?stopped`, handled BEFORE
`openApp` runs. That document shows a reopen action; the action removes the
marker and performs full navigation. A query marker in a template is not enough
if component initialization already opened an App. Keep this branch in the
existing boot composition rather than adding a general route coordinator.

AppBoot computes `opening` conditionally: recovery leaves it undefined and never
calls `openApp`. Its rendering branch then shows the explicit reopen action.

On retirement, reject access first, make the current UI inert, and request full
replacement. Navigation may be delayed, cancelled, or fail to start. The inert
fallback remains safe and offers retry; it does not acquire another App.
Remove the working UI's `beforeunload` handler before forced replacement so it
cannot veto retirement. Framework update waiting used for removal is not a
producer drain. Preserve native document-loss cleanup and library retirement.

Deliberate browser sign-out sets a local leaving state before calling
`auth.signOut()`, which publishes retirement synchronously. Its retirement
observer must not navigate during that operation. Remove the working UI, await
the auth result, then navigate to the intended destination. Failure leaves an
inert error/retry view. Keep only the state needed to distinguish deliberate
leaving from unexpected retirement; no producer registry or drain returns.

A best-effort `App.close()` backstop may remain for unexpected component unmount
or HMR, including opening that resolves after unmount. It must observe rejected
promises. It neither gates navigation nor reinstates a page-lifetime controller.
Trace browser back-forward cache restoration and use a narrow fresh-document
rule if a retired document can return. Do not auto-reload repeatedly on failure.

## Implemented callers

Honeycrisp's `SignInButton` consumes AppBoot's existing connection action through
context. Whispering's library action removes AppBoot, stamps the departing
history entry as stopped, and requests full navigation with an inert fallback.
Its signed-out Personal selection uses the connection action so desktop OAuth
cancellation leaves the working document intact.

AppBoot owns account-change warning placement and browser navigation. Desktop
sign-in preserves working UI before acceptance; desktop sign-out never falls
through to browser navigation. Sign-out can supersede a pending sign-in, and
late completion after unmount cannot navigate another page.

## Deletion map

| Family | Final disposition |
| --- | --- |
| `application-close.rs`, `CloseApplications`, `ResumeApplications`, `finish_application_close`, close capabilities/permissions | Delete with their handlers and stale command allowlists |
| `closeApplications`, `resumeApplications`, `recoverConnection`, prepare/resume state | Delete after desktop transitions cannot mutate their live boot identity |
| Boot-account drift repair and `bootStorageRetired` | Remove only once no successor is published and late writes are fenced |
| `desktop-close.ts` and AppBoot native-close wiring | Delete after the host stops asking for acknowledgements |
| `page-lifetime.svelte.ts`, its test adapter, `Leave` | Delete after all exits and retirement use the new document rule |
| `app-cleanup.ts`, shell `preflight`, departure registrations | Delete with their callers |
| App-specific drains and pending promise sets | Trace callers; delete departure-only members and matching obsolete tests |
| `App.close`, storage close/discard, acquisition rollback | Retain: resource and failure boundaries have non-departure callers |
| Component disposals, account request/socket fences, native document cleanup | Retain where they own resources or correctness while their parent survives |

Tests are evidence, not an excuse to retain an otherwise dead production
abstraction. Conversely, do not delete a callable resource release that supports
real reopening, acquisition failure, or a different runtime. No compatibility
exports, selectable shutdown modes, timeout drains, or replacement cleanup registry.

## Evidence so far

Earlier investigation used a temporary Vite transform of the existing browser
durability fixture, actual `openApp` and browser storage, and full reloads.
These results describe one unloaded development machine, not a latency promise:

- Thirty 1 KB row writes per engine completed in sub-millisecond to a few
  milliseconds; this measured flush completion, not power-loss durability.
- Fifty immediate write/reload/reopen repetitions each in Chromium and WebKit
  reopened successfully and retained all sampled rows.
- With an injected 200 ms commit delay, Chromium retained 0/3 new rows at 0 ms
  reload delay, 0/3 at 100 ms, and 3/3 at 300 ms. Reopening still succeeded.
- An earlier longer WebKit probe stalled without a diagnosed cause. Passing
  later bounded runs does not explain that stall.
- Native tests `document_departure_preserves_saved_output_and_fences_stale_commands`
  and `stop_saves_once_and_saved_audio_survives_document_close` passed.

The temporary scripts are not durable acceptance tests. Reproduce the decisive
controls in maintained evidence before shipping. No actual process restart or
live microphone interruption was tested in that investigation.

## Implementation waves

### Execution evidence: 2026-09-19

- Task-start tracked diff and untracked files copied to
  `/var/folders/qx/9462vg517cvdtpjr4tt32_200000gn/T/runtime-lifetime-baseline-vQMeO1`.
  Other auth/scope work continues in this checkout; re-read files before edits.
- Baseline `bun test packages/auth/src apps/epicenter/src apps/epicenter/scripts`:
  306 pass, 0 fail. Log: `/tmp/runtime-lifetime-baseline-tests.log`.
- Baseline focused package typechecks: auth and Epicenter pass. App-shell,
  Honeycrisp, Vocab, and Whispering report the concurrent `Account.supportsShared`
  mismatch in `packages/app/src/open.ts`. Log:
  `/tmp/runtime-lifetime-baseline-types.log`.
- Baseline native suite: 162 pass, two ignored, zero failures. Baseline app-shell
  boot-screen tests: 24 pass. Logs: `/tmp/runtime-lifetime-baseline-native.log`
  and `/tmp/runtime-lifetime-baseline-shell.log`.
- Maintained browser evidence passes in Chromium and WebKit: 50 immediate
  edit/reload/reopen cycles preserve committed data; 20 immediate window reopen
  cycles succeed; three delayed pending-write loss controls reopen cleanly;
  completed delayed commits survive. Commands:
  `bun packages/app/evidence/data/browser/durable-store.ts` and the same command
  with `--webkit`. The earlier WebKit stall did not recur; its cause is unresolved.
- Review added 20 same-task edit-and-reload cycles per engine, with no driver
  round trip before navigation. All committed data survived and every new claim
  succeeded. Chromium retained 20/20 pending edits; WebKit retained 12/20.
  These are observations, not pending-write guarantees. Window-close repetitions
  now also begin with an unflushed edit. The parent bounds the probe process and
  owns temporary-profile cleanup.
- Native replacement evidence passed 20 actual Tauri restarts and 20 immediate
  installed-window reopens. Real `openApp` IndexedDB markers survived; all 21
  native host PIDs and 21 Bun sidecar PIDs terminated. Command:
  `bun apps/epicenter/scripts/native-runtime-evidence.ts`. Native startup exposed
  a `baseUrl`/`baseURL` wire mismatch; the Rust field now emits the exact Bun
  contract spelling, covered by a serialization assertion. Initial fixture IPC
  refusal was diagnosed as missing remote command admission, not a storage stall.
- Actual physical microphone evidence could not reach capture: CoreAudio returned
  `OSStatus 560947818`, "Failed to read the input device name". The maintained
  probe was attempted; live microphone interruption remains unverified. Its
  fixture now supplies the current `BlobDestination.account` and retry `appId`.
- Claude consultation `0bb47f91-e185-4835-a4b1-661d0bff4e1e` completed without
  permission denials. Recommended retiring the boot auth owner before one direct
  credential write, then bounded revocation and restart. The verification-mismatch
  writer checks attachment ownership inside its queued operation; a write already
  started synchronously enters the native write queue before the successor.
  This ordering needs regression coverage before adoption. Failed writes remain
  terminal and cannot establish what storage contains.
- Claude reviewed the browser evidence checkpoint. Accepted repairs: same-task
  navigation, a positive auth-mismatch control, explicit no-revocation disposal
  coverage, and observation of the verification body before checking late writes.
  The focused account-lifetime suite now has 15 passing tests. Retained the
  independent watchdog owner because a hung browser protocol must remain bounded.
- The user approved the single warning authorizing recording and draft loss.
  Shared account entry points and desktop Home now warn without window vetoes.
- Desktop authority captures one Account and writes next-boot credentials directly
  after disposing its auth owner. Authority: 36 tests / 249 assertions pass;
  Epicenter typecheck passes. Tests cover queued old writes, late callbacks,
  mutation-before-write-failure, bounded revocation, and terminal restart failure.
- Native close/resume handlers and definitions are deleted; paired protocol is v7.
  Rust: 157 pass, 2 ignored. Sidecar: 30 pass. Production Relaunch evidence passes
  twenty restarts and immediate window reopens with committed markers; all
  twenty-one host/sidecar process pairs terminate. Stale-generation and shutdown
  native effects are rejected. Physical microphone interruption remains unverified
  because CoreAudio failed to open the device before capture.

### 1. Prove process and document replacement

- [x] Inventory account-change entry points: sign-in screen/panel, account
  popover including its no-AppBoot sign-out fallback, Whispering account
  settings, and desktop home settings. Resolve warning ownership before wave 2;
  independent probes may proceed. Do not add per-window dirty-state collection.
- [x] Add an isolated native probe with temporary storage and no personal account:
  persist a marker, restart with windows open, reopen, and verify it at least
  twenty times. Exercise actual Rust host and Bun sidecar termination.
- [x] Destroy and immediately reopen an installed app window; verify admission
  succeeds and committed data remains.
- [ ] Verify physical native capture interruption and reacquisition with a working
  microphone. The attempt failed before capture with CoreAudio OSStatus 560947818.
  Recorder document-loss unit tests and synthetic browser interruption pass.
  Remaining manual run: record, confirm sign-out, observe actual restart and
  microphone-indicator release, record again, and check staged-file cleanup.
- [x] Diagnose the WebKit probe stall or produce a bounded reproducer with
  navigation, process-exit, console, and claim-result evidence.
  Limit this investigation to three bounded runs per relevant scenario. If it
  does not reproduce, retain the unresolved observation and record the evidence;
  do not turn an unexplained earlier stall into an indefinite implementation gate.
- [x] Check focused-input commits, browser history restoration, dirty-draft
  forced navigation, and a recovery document that never opens an App.

### 2. Make desktop identity a process boundary

- [x] Implement the next-boot transition in the existing desktop authority using
  shared credential verification and ordered native credential storage.
- [x] Prove cancellation, concurrent acceptance, orphan results, credential-write
  failure, bounded revocation, and restart failure. Old windows never receive
  the successor Account or credential, including same-person re-login.
- [x] Force restart failure, then reload and reopen app windows. Each shows
  restart-required UI and opens no App. Successful restart must not hit the
  current native "Refused relaunch" guard.
- [x] Switch native relaunch and auth callers off close/resume together. Keep
  old definitions temporarily unused while the replacement is verified.
- [x] Run authority, broker transport, sidecar protocol, native capability, and
  restart evidence. Then delete the unused close/resume implementation.

Do not first remove recovery while still using mutable live installation. That
would create an intermediate state without either the old protection or the new
invariant. Split into commits only where each intermediate behavior is complete.

### 3. Make application identity a document boundary

- [x] Implement the boot-free recovery destination and immediate inert fallback.
- [x] Route controlled exits through full navigation or host restart. Move the
  single confirmation to the action owner; remove shell departure preflight.
- [x] Remove all imports of the page controller, cleanup registration, and
  native-close listener. Verify browser and native flows before deleting files.
- [x] Trace and delete app-specific departure-only drains. Preserve ordinary
  component lifetimes, storage rollback, and host resource disposal.
- [x] Replace tests of veto/drain ordering with tests of interruption, committed
  data survival, retirement fencing, and clean restart/reopen.

### 4. Finish the clean break

- [x] Search all callers, exports, capabilities, generated command names, tests,
  smoke probes, READMEs, and agent guidance for the removed model.
- [x] Apply post-implementation review against the whole changed lifetime.
- [x] Update docs to the shipped behavior. Preserve ADR acceptance rules; do not
  self-assign acceptance. Add amendment backlinks when the decision is adopted.
- [ ] Delete this spec after physical microphone acceptance is complete.


### Final implementation evidence

- Desktop authority: 37 tests / 259 assertions. Combined auth/host/scripts:
  317 pass. All relevant desktop and auth typechecks pass.
- AppBoot evidence passes Chromium and WebKit: warning cancellation preserves
  work; accepted departure ignores held work; sign-out waits for credential work;
  dirty draft handlers cannot veto retirement; HTTP 204 retains an inert old
  document; actual Back returns recovery without acquisition; persisted-page
  restoration requests recovery; pending opening rolls back after unmount.
  Pending desktop sign-in can be superseded by sign-out. Late sign-out completion
  cannot navigate after unmount; the real AccountPopover still reports a held
  sign-out failure through the global toast after its own removal.
- Ordinary persistence evidence rerun: both engines pass 50 edit/reload cycles,
  20 immediate reopen cycles, 20 same-task pending-write cycles, three intentional
  delayed-write-loss controls, committed-delay survival, and namespace isolation.
  Pending-write survival varied between runs; it is not an acceptance promise.
- Whispering: 186 tests, browser and desktop typechecks pass. The actual UI probe
  records synthetic speech, uses cached native Whisper and Ollama, interrupts an
  active Personal recording with one warning, reopens Local capture, and verifies
  exact saved-audio hash survival. Physical CoreAudio is not covered by this probe.
- Vocab: 51 tests and typecheck pass. Mail: 8 unit tests and all three typechecks
  pass; actual saved-query and route journeys pass Chromium and WebKit. The
  desktop-warning route fixture checks actual rendering with synthetic auth.
- Post-implementation review removed the unused Tauri dependency and unreachable
  local-data-removal callback chain. Kept separate Home warning copy because Home
  does not depend on app-shell; adding that dependency for two lines would widen
  its UI closure. Repaired background account retirement, query-cache disposal,
  missing Mail dialog mounting, pending-sign-in/sign-out interaction, and late
  unmount navigation. No replacement lifecycle framework was introduced.
- Documentation hygiene baseline reproduced from recorded HEAD plus dirty patch
  and saved files: 57 issues. Concurrent shared-data changes add ADR-0416's issue.
  ADR-0415's implementation is no longer marked unbuilt; its status is unchanged.
  Do not self-assign ADR acceptance to make the checker pass.

### Microphone retry after device connection

The physical capture probe was rerun after the user connected a microphone.
macOS `system_profiler SPAudioDataType` still listed only Mac Studio Speakers,
with no input device. Capture again failed before acquisition with CoreAudio
`560947818` (`!obj`, invalid audio object). Silence would be acceptable; the
missing usable input device prevents the test from reaching capture.

The retry exposed a probe exit-status bug: Wry returned zero after the failure
path requested exit. The maintained example now exits successfully only after
all capture and saved-audio assertions pass. The repeated negative run correctly
exited 1. Production recorder code was not changed. Physical interruption and
restart during capture remain outstanding until macOS exposes an input device.

## Acceptance and limits

The change is complete when no production caller negotiates per-window cleanup,
no page registers an asynchronous departure drain, and each supported runtime
passes the replacement evidence. A late callback cannot overwrite next-boot
credentials. A failed restart cannot expose the successor to the old process.
The stopped destination acquires no store, and committed data survives restart.

Keep implementation scope on lifetimes. No schema migration, new recording
format, background recovery daemon, automatic account switching, runtime server
selector, or generalized shutdown policy belongs to this work. New data-loss
cases beyond the agreed interruption policy return to product judgment.
