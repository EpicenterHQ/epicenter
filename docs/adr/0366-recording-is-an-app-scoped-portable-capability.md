# 0366. Recording is an app-scoped portable capability

- Status: Proposed
- Date: 2026-09-08
- Revised: 2026-09-09
- Unbuilt: Concurrent native capture on distinct input devices and opaque device selection. Saved recording exists with a single host-wide slot; two-device native acceptance remains outstanding.

## Context

Whispering owned the JavaScript interface to a recorder that already ran in
Epicenter's native host. That recorder writes the canonical blob layout, but
hardcoded Whispering's application ID. Local transcription reached those bytes
through a recorder module. An application that only wants to capture audio
should not need Whispering's settings, rows, or native wrapper.

## Decision

An opened App reaches saved capture through `app.device.recording`. The build selects
the browser or desktop implementation. Defining an Application
acquires no microphone, opens no dataset, and loads no inference model.
The browser implementation uses browser capture; the desktop implementation
uses the native recorder's invoke commands. The session contract is shared.

Capture belongs to the machine, so the capability sits on the device scope and
`start()` names the store the audio lands in (ADR-0401). The opened App
captures the application identity once. `start()` and `current()` take no
account argument and require successful App readiness. Start returns a Recording in a Wellcrafted Result. Its `stop()`
publishes completed audio into that destination and returns the audio blob ID,
duration, and byte length. Its `cancel()` discards it. Changing
the selected account never retargets an existing session. Recording itself
does not upload audio or create an application row.

### One native owner, independent sessions

The desktop host owns capture admission across application windows. It reserves
each resolved input device for one capture at a time. Whispering can keep a
saved recording running on one device while a second App captures on another. Every destination uses the same
owner; a capture's destination store does not partition or duplicate
microphone ownership.

```text
Native capture owner
  device 1 -> Whispering Recording -> destination store's audio blob
  device 2 -> second App's Recording -> its destination store's audio blob
```

The host tracks sessions by opaque identity and checks the invoking window.
App capabilities also retain the destination store named at start. Returned handles stop
or cancel their own sessions. An old timer or key release cannot stop a newer
capture. Putting a shared stop on the Application or App would lose that
identity. Products can keep a current handle for their stop button.

Admission uses the backend's device identity, with a separate display label.
Selecting the system default resolves it once before reservation. An explicitly
selected device that disappears fails; it does not silently switch to the
default or another free microphone. Two devices with identical names remain
distinguishable. Device identifiers need not survive every backend or hardware
reconfiguration.

A competing start on a reserved device returns a typed busy Result without
interrupting the existing session. Permission, missing-device, and backend
failures are also Results. Preserve a backend's device-busy classification when
it supplies one; an unknown backend failure must not be guessed to mean busy.
Rust errors cross the bindings into TypeScript `defineErrors` variants.

Reservation covers startup, capture, and physical teardown. The shared registry
lock covers state transitions only. Device opening, worker waits, stream teardown,
disk operations, and inference run outside it so one device cannot block control
of another. A pending acquisition already belongs to its caller; owner loss
cannot leave a late successful start orphaned. Release the device after capture
teardown, while publication or transcription continues under its session.

This is admission within one native host. OS clients and drivers can still refuse
capture. The initial concurrent contract covers independently enumerated input
devices. Two channels of one audio interface, same-device fanout, and synchronized
multi-track recording need separate decisions.

### Recovery and closure retain ownership

Each App retains one unresolved saved Recording, keeping `current()` unambiguous.
That does not prevent another App's recording or dictation on another device.
The same App can also dictate on another device while its saved recording runs.
Supporting several saved recordings in one App would require explicit session
lookup or enumeration instead of silently choosing one during recovery.

Reload can recover the window's unresolved saved recording after checking its
application and destination store. Unexpected capture termination preserves
accepted audio until the owner stops or cancels. Recoverable audio retains its
session identity, but no longer reserves a microphone after capture teardown.
Temporary dictation is not adopted as a saved recording.

Native events identify their session as well as their receiving window. Window
destruction cancels every capture it owns. The tray reflects whether any session
is capturing. Browser sessions belong to their document; separate browser
documents do not acquire a shared native admission guarantee.

Application closure awaits admitted work and cancels its unresolved sessions
before releasing their dependencies. It leaves another App's captures running.
Applications that retain final audio or text finish and save it before calling
`app.close()`.

Native blob storage owns app/dataset paths, staged publication, metadata, and
cleanup independently of audio. The recorder supplies completed WAV data and
its content type. Audio decoding consumes general blob reads. Transcription
and upload encoding use the same explicit destination as recording. No native
storage module names Whispering.

Permanent recording and microphone-to-text dictation have separate outcomes.
There is no shared dictation capability: an application that wants text from
the microphone composes this capture with a connection's `transcribe`
(ADR-0396) itself, and owns its own session, transcript, and cleanup. A
shared helper is promoted only when a second application needs more than
those two calls.

## Consequences

Whispering retains its history, recipes, insertion, retry, and retention policy.
Other applications can capture without importing Whispering. Native and Bun
writers still share an on-disk contract across languages, so agreement needs
tests. Browser capture cannot promise native reload survival or identical
encoding. Runtime differences do not change the application-facing methods.

## Considered alternatives

- Put recording on Epicenter and pass an account at each start: repeats a storage
  decision already made by opening the app and separates capture from its close gate.
- Rename Whispering's service without changing ownership: leaves native paths
  and imported-audio decoding tied to Whispering's recorder.
- Send native audio through the WebView to save it: adds an audio-sized transfer
  where native storage can publish the same bytes directly.
- Run recording in Epicenter's main window: ties a host mechanism to a UI that
  can close while other application windows remain open.
- Save every dictation session as a permanent blob: gives text-only consumers
  unnecessary storage and cleanup obligations.
- Keep one host-wide capture slot: prevents recording on one microphone while dictating on another.
- Allow every start to open the same device: delegates session arbitration to backend behavior and changes the meaning of contention across platforms.
- Share every microphone stream among subscribers: requires fanout and coupled configuration without serving the distinct-device workflow.

## Implementation

Saved recording is implemented in the [App recording contract](../../packages/app/src/recorder.ts),
[application composition](../../packages/app/src/index.ts), and
[native blob storage](../../apps/epicenter/src-tauri/src/blobs.rs).
Whispering selects the runtime implementation at its platform seam.

The actual Whispering browser UI records, saves, transcribes, plays, and reopens
identical audio in Local, Personal, and Shared. Native file inference has real
WebView evidence. Native microphone capture, host blob playback/reopen, and
active-capture reload recovery still need a controllable input fixture.

The native implementation still holds one `Option<HeldRecording>` and identifies
devices by display name. A second start is refused globally. Per-device admission,
session-scoped level events, and concurrent cleanup require Rust and generated
binding changes. CPAL's device and stream APIs permit the proposed ownership;
they do not establish that every hardware pair will open successfully. The
[concurrent native capture spec](../../specs/20260912T122859-concurrent-native-capture.md)
records the source evidence and two-device acceptance cases.

Lifecycle tests cover publication, cancellation, captured identity, recovery,
and resource cleanup. The browser smoke captures and decodes synthetic microphone
audio. The native storage smoke reads Rust-produced metadata and bytes through
the public Bun blob store. Both Whispering production targets build.
