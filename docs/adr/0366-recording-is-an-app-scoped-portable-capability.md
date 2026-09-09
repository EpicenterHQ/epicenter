# 0366. Recording is an app-scoped portable capability

- Status: Proposed
- Date: 2026-09-08

## Context

Whispering owned the JavaScript interface to a recorder that already ran in
Epicenter's native host. That recorder writes the canonical blob layout, but
hardcoded Whispering's application ID. Local transcription reached those bytes
through a recorder module. An application that only wants to capture audio
should not need Whispering's settings, rows, or native wrapper.

## Decision

An opened application reaches saved capture through `app.recording`. Application
composition selects a browser or desktop implementation. Constructing Epicenter
acquires no microphone, opens no dataset, and loads no inference model.
The browser implementation uses browser capture; the desktop implementation
uses the native recorder's invoke commands. The session contract is shared.

`openLocal()` binds recording to the application's local library.
`openAccount(account)` binds it to that account's library. The opened app captures
the application ID and dataset identity once. `start()` and `current()` take no
account argument and require successful app readiness. Stop
publishes completed audio into that destination. Cancel discards it. Changing
the selected account never retargets an existing session. Recording itself
does not upload audio or create an application row.

The desktop host owns microphone arbitration and associates capture with its
invoking window. Reload can recover that window's unresolved recording after
checking its destination. Window destruction cancels it. Browser sessions
belong to their document. A capture that ends unexpectedly keeps accepted
audio until the owner stops or cancels. Application closure awaits admitted
work and cancels unresolved capture before releasing its dataset. Applications
that retain the final audio must stop and save it before calling `app.close()`.

Native blob storage owns app/dataset paths, staged publication, metadata, and
cleanup independently of audio. The recorder supplies completed WAV data and
its content type. Audio decoding consumes general blob reads. Transcription
and upload encoding use the same explicit destination as recording. No native
storage module names Whispering.

Permanent recording and microphone-to-text dictation have separate outcomes.
Dictation can compose lower capture mechanisms and own temporary audio without
opening a dataset or publishing a recording. Shared capture does not require
that every consumer retain audio. The AI dictation proposal remains a separate
implementation task.

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

## Implementation

Implemented in the [shared recorder](../../packages/recorder/README.md),
[application composition](../../packages/app/src/index.ts), and
[native blob storage](../../apps/epicenter/src-tauri/src/blobs.rs).
Whispering selects the runtime implementation at its platform seam.

Lifecycle tests cover publication, cancellation, captured identity, recovery,
and resource cleanup. The browser smoke captures and decodes synthetic microphone
audio. The native storage smoke reads Rust-produced metadata and bytes through
the public Bun blob store. Both Whispering production targets build.
