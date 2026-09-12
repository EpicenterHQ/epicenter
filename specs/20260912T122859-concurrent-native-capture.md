# Concurrent native capture

- **Status:** Draft
- **Date:** 2026-09-12
- **Executes:** [ADR-0366](../docs/adr/0366-recording-is-an-app-scoped-portable-capability.md) at "One native owner, independent sessions"
- **Surface:** `app.device.recording` per [ADR-0392](../docs/adr/0392-an-app-has-a-device-scope-and-an-account-scope-and-each-store-sits-under-its-owner.md); `start()` names the destination per [ADR-0401](../docs/adr/0401-a-record-names-its-destination-at-creation.md)
- **Grows from:** `specs/20260908-ai-client-and-portable-dictation.md` (deleted 2026-09-12; its client half was decided by ADR-0392 and ADR-0396, and its shared dictation capability was withdrawn)

The native host admits one capture per resolved input device instead of one
capture per host, so two Apps, or one App twice, can capture on two
microphones at once.

The target workflow is a long Whispering recording on microphone one while a
second App captures short phrases on microphone two. Today the recorder holds
one `Option<HeldRecording>` and refuses every second start before resolving
its device. Completion requires that real two-device workflow, independent
session cleanup, and typed contention on the same device.

This spec owns the Rust admission model, its commands and events, and the App
adapter over them. It does not own a shared dictation contract: an application
that wants microphone-to-text composes `app.device.recording` with
`connection.transcribe` itself (app-hub spec, Open Question 3, resolved to
option c). It does not authorize replacing native behavior with a fixture or
adding a second recorder owner.

## Current evidence

- `apps/epicenter/src-tauri/src/recorder/` owns capture; `transcription/`
  owns native model residency. Neither changes ownership here.
- `packages/app/src/recorder.ts` is the saved-recording contract;
  `packages/app/src/recording/desktop.ts` is the adapter over the native
  commands. Wave 1.4 of the app-hub spec changes `RecordingFactory` to
  `(appId, options)` with `start(params)` naming the destination store. This
  spec lands on that signature, not the current one.
- `apps/epicenter/src-tauri/capabilities/` scopes native access by app window
  and origin. Re-read the current grants before introducing session commands
  or channels; `honeycrisp` and `mail` windows do not hold the trusted
  app-window capability today (greenfield spec, open question).
- Source review on 2026-09-09 checked Epicenter against its installed CPAL
  0.18.1 and Tauri 2.11. No hardware capture was performed for that review.

## Dependency

Land after app-hub wave 1.4 (`RecordingFactory` drops `replica`; `start`
names the destination). Everything below is independent of the two-scope
migration otherwise, and the Rust work can proceed in parallel with waves 2
through 4 as long as the adapter is written against the wave 1.4 signature.

## Build backward

### 1. Extend native admission

Keep one native owner. Replace its global recording slot with session
ownership and a reservation per resolved input device. Retain the current
limit of one unresolved saved recording per App, so
`app.device.recording.current()` has one answer. A second capture from the
same App on another input is admitted; this does not introduce multi-track
saved recording within an App.

```text
Native capture owner
  sessions: session ID -> caller, input, phase, worker, outcome
  inputs:   resolved device ID -> session ID

Whispering App -> Recording -> mic 1 -> native staged WAV -> destination store blob
Second App     -> Recording -> mic 2 -> native staged WAV -> destination store blob

starting -> capturing -> stopping -> capture released
                                         |
                              publication settles under the session
```

Use CPAL device IDs for native selection and reservation; keep labels for UI.
Resolve the default once. A missing explicit device fails instead of falling
back. Existing persisted native selections are names: convert only an
unambiguous match, otherwise retain the unresolved choice and ask for
reselection in the product UI. Do not mistake a browser device ID for a
native one.

Register the pending caller before asynchronous preparation. Resolve the
device outside the shared lock, then atomically check that the owner is still
live and reserve that device. Do stream creation, readiness waits, worker
joins, and disk work outside the shared registry lock. A window closing during
startup must cancel the registered attempt; late success must tear down its
own stream. Release a reservation only after capture teardown is established.
Keep failed release isolated to that device. Retained staged audio stays
claimable without retaining its device reservation.

Update commands, generated bindings, permissions, and the App adapter
together. Every command and event needs session identity and owner
validation. Add identity to level events; ensure ended events and recovery
identify their session. Window destruction must visit all its sessions, while
App closure settles only that App's work. Aggregate tray state across active
capture.

Keep the existing per-session worker and bounded sample handoff. Write saved
audio incrementally in native storage. No registry lock, file work, inference,
or IPC belongs in the audio sample callback. Allocation-free sample transport
is a later measured optimization, not a prerequisite to correct ownership.

Preserve typed admission busy, backend device-busy, permission, and
missing-input failures through Rust and `defineErrors`. Do not parse human
error messages. The same-device rule is host policy; it cannot guarantee
OS-wide exclusivity or recognize every backend refusal as contention.

### 2. Prove the lifecycle in desktop

Extend the existing recorder owner. Do not start another recorder owner
inside an adapter. Register the required commands, channels, generated
bindings, and app-window permissions together.

Drive real audio through start, stop, and cancel on two devices. Cover
startup failure after partial acquisition, microphone loss, overlapping
starts on one device, stop called twice, cancel during stop, settings changes
during capture, and owner-window loss. Define when stop errors use its Result
rather than `onEnded`, and ensure the consumer does not receive duplicate
terminal notifications.

Session handles remain valid identities after microphone release. A previous
session's publication may settle while the next one captures; its completion
must not affect the next session. Bound pending publication so a slow disk
cannot accumulate work indefinitely.

Deliberate App close cancels its unresolved sessions. Abrupt reload keeps the
existing saved-capture recovery contract: recovery matches the window's
session to its App and destination store, and never adopts another App's
capture.

### 3. Keep browser capture out of scope

The browser implementation of `app.device.recording` belongs to its document
and acquires no shared native admission. Nothing here changes it. The shared
session contract stays identical; only the native owner's admission changes.

## Caller changes

Whispering already retains the session it started. In
`apps/whispering/src/lib/operations/recording.svelte.ts`, the actual start is:

```ts
const params = manualRecorderConfig.resolveStartParams();
const { data: recording, error: startError } =
    await service.start(params);
```

This remains the call after native concurrency lands, with `params` also
carrying the destination store per wave 1.4. `selectedDeviceId` identifies the
exact native input. Its captured `recording.stop()` keeps returning saved
bytes; another App's capture no longer causes a host-wide busy refusal.
Whispering's history, rows, and insertion policy remain above saved capture.

## Native evidence

| Current evidence | Required change or constraint |
| --- | --- |
| `recorder/recorder.rs`: `Recorder.active: Option<HeldRecording>` and `require_free_slot` | Admission currently refuses every second session before resolving its device |
| `enumerate_devices` and `resolve_device` use display names and default fallback | Use actual device identity, distinct labels, and refusal for a missing explicit selection |
| `recorder/commands.rs`: start waits for readiness and stop joins under the recorder mutex | Move blocking work outside the shared lock; an async Tauri command alone does not do this |
| Recording startup already creates a worker, stream, bounded sample queue, and staged file | Extend this ownership rather than introducing an audio mixer or shared-stream subscribers |
| `mic-level` carries only a number; `current_recording` is singular per window | Identify events by session and recover only the matching App's saved recording |
| `RecorderError::classify_cpal` maps `DeviceBusy` to generic `Failed` | Preserve a supplied backend-busy classification through the public Result |
| `close_capture_and_drain` stops waiting for callback senders after 50 ms | A timeout is not proof of release; establish the actual stream teardown boundary |
| `downmix_*` averages all input channels | Two sockets on one interface are not automatically two separately selectable devices |

CPAL constructs an owned stream from a device and exposes `id()` and
`device_by_id()`. Its contract supports independently owned streams;
successful dual-device acquisition still depends on the backend and hardware.
[CPAL 0.18.1 device and stream traits](https://github.com/RustAudio/cpal/blob/v0.18.1/src/traits.rs)

CPAL's CoreAudio implementation owns property listeners on a dedicated thread
and supports sending the stream between threads. Epicenter's older comment
requiring its own stream and run loop to stay on one thread is not a CPAL
0.18.1 constraint. Reassess the extra platform event pumping with an unplug
test before removing it.
[CoreAudio implementation](https://github.com/RustAudio/cpal/blob/v0.18.1/src/host/coreaudio/macos/mod.rs)

Tauri runs async commands as tasks; blocking waits still require a worker or
the blocking executor.
[Tauri async commands](https://v2.tauri.app/develop/calling-rust/#async-commands),
[blocking executor](https://docs.rs/tauri/latest/tauri/async_runtime/fn.spawn_blocking.html)

WASAPI opens input in shared mode, but external exclusive clients or drivers
can still refuse access. Linux ALSA device aliases and sound-server ownership
need backend-specific acceptance. Do not equate two enumerated aliases with
two independent physical microphones.
[WASAPI implementation](https://github.com/RustAudio/cpal/blob/v0.18.1/src/host/wasapi/device.rs),
[CPAL backend guidance](https://github.com/RustAudio/cpal/blob/v0.18.1/README.md#alsa-pipewire-and-pulseaudio)

## Acceptance

Test admission and lifecycle with deterministic workers, then prove the actual
audio path in packaged native builds. Current mocked IPC tests do not
establish the following outcomes:

| Scenario | Required outcome |
| --- | --- |
| Long Whispering recording on mic 1; repeated short captures from a second App on mic 2 | Both sources are correct, saved audio remains continuous, each blob reaches its own destination store |
| Two input devices with identical display names | Selection and reservation distinguish their opaque IDs |
| Same-device starts race, including while a previous capture is stopping | One admitted capture; typed busy refusal leaves it intact |
| Mic 2 startup or teardown stalls | Mic 1 remains controllable; no shared lock waits on mic 2 |
| Explicit mic 2 disappears or system default changes | No silent retargeting; an already resolved session keeps its identity |
| Unplug one mic | Only its capture ends; accepted saved audio remains recoverable |
| Old session's stop, error, or ended event arrives late | No effect on a newer session or another App |
| App close or owner-window destruction during startup | Pending acquisition cannot leave an orphaned stream; other owners continue |
| Reload with saved capture | Exact saved recovery to the matching App and destination store |
| Long run under CPU and disk pressure | Bounded memory and pending work; measure sample drops and recording continuity |

Record the backend, OS, and device pair for macOS/CoreAudio, Windows/WASAPI,
and each supported Linux configuration. Source compatibility is not hardware
proof.

## Completion evidence

- Two Apps capture on distinct devices at once in a packaged desktop build, with same-device contention returning a typed busy Result.
- Every native command and event carries session identity; recovery and window destruction act on exactly the sessions they own.
- No shared lock waits on device I/O, worker joins, or disk work.
- One recorder owner remains; no adapter constructs a second.
- An independent adversarial review checks the cumulative implementation and the real evidence before integration.

When execution finishes, delete this spec and update ADR-0366's `Unbuilt` line
and implementation section. Follow the repository ADR status policy.
