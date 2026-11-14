---
name: services-layer
description: Apply Epicenter's service-boundary patterns for UI-free capabilities, explicit inputs, Result fallibility, lifecycle factories, and a capability package that picks its browser or desktop implementation when the page runs. Use when creating or refactoring an app's services or their contract, provider or connection dispatch, or a desktop service over the shell, the credentials file, or the account.
metadata:
  author: epicenter
  version: '5.0'
---

# Services Layer

Grounded in Whispering (`programs/whispering/src/lib/app.ts` and
`whispering.svelte.ts`) and `@epicenter/ai`'s `customEndpoints()`
(`connection-keys.ts`). Read the app's `app.ts` and the capability package's
entry before changing a service.

## Product Sentence

A service owns a UI-free capability; the app passes in what it decides,
fallible operations return Results, and the package that owns a capability
picks its browser or desktop implementation when the page runs.

## Boundary

Services may perform I/O and own service-local state. They stay free of UI
and app policy:

- no reads of Svelte state, settings notes, toasts, or reporting;
- credentials, endpoints, models, paths, and the store come in as inputs;
- domain data and tagged errors come out, not presentation copy;
- a capability's browser and desktop implementations share one type.

A service never chooses or opens the store. It is made over the folder
`src/lib/app.ts` opened: Whispering's `createMicrophoneDevice({ files:
folder.audio, recorder })` and `createWhispering` (`whispering.svelte.ts`),
so a recording lands in the same store the pages read.

## Where the page runs

One build serves the web and the desktop (see the `platform-seams` skill).
The capability package picks its implementation: it decides presence with
`isTauri()` when its module loads, and loads its desktop code with
`import()` in its asynchronous step. The app imports one name
(`recorder` from `@epicenter/recorder`, `customEndpoints()` from
`@epicenter/ai`), and a capability a surface lacks is `null` there
(`localSpeech()` in a browser). App code never checks `isTauri()`.

On the desktop, a service reaches native code only through the app's shell
and the shared crates, never through a credential in the page:

- **Secrets** live in the app's `credentials.json` in AppData (mode
  `0600`), which only `epicenter-account` reads and writes and no page
  reaches
  ([ADR-0740](../../../docs/adr/0740-every-credential-an-app-holds-lives-in-its-own-place.md)).
  A connection's key is handed to the shell once (`connectionKey` in
  `@epicenter/ai`'s `tauri.ts`, over `connection_key_set` and
  `connection_key_move`) and read by the request that uses it;
  `connections.md` in this computer's settings records which endpoint it
  was entered for, never the key. Never put a key in a settings file, the
  data folder, or WebView storage.
- **The account** is a relay: requests go through `account.fetch`, which
  the shell sends with `account_fetch` and a token the page never sees.
- **Other requests** to a custom endpoint or a server on this computer
  leave through the shell (`connection_fetch`, and `shellFetch` with no
  key), so no endpoint needs a CORS rule for the window's origin.
- **A root-scoped native command** (the recorder, local transcription)
  names the data folder's root by name (`'Data'`), never by path; the shell
  refuses a root the window did not open.

Read [service organization and platform variants](references/service-organization-platforms.md)
when adding or moving a service.

## Model Fallibility Honestly

Use `Result<T, E>` for an operation that can fail in ordinary use. Adapt
throwing platform or library calls with the `error-handling` skill.

Do not fake a Result for an infallible in-memory action or a cleanup. Errors
belong to the layer that understands the failure: pass lower-layer tagged
errors through (`TranscriptionError`, `RecorderError`), and define a
service-local variant only for a failure the service owns. Use
`error-handling` for variant shape, message rules, adaptation, and
propagation.

## Direct Object Or Factory

Default to a plain object when construction has no input or lifecycle. Use a
factory when it owns real construction inputs or a lifecycle: Whispering's
capture device (`createMicrophoneDevice`, over the folder's audio and the
package's `recorder`) owns one recording session at a time with its stop
and recovery. Do not add `create*` only to
call it once at module load. See
[service implementation patterns](references/service-implementation-pattern.md).

## Runtime choices stay at the call

Which connection or provider a request uses is run-time state, not a build
choice. Whispering's `transcribe` and `transform` read the selected
connection (account, custom, or local on the desktop) when the request is
sent, and send only while it is still the connection the request was
prepared for. Keep that dispatch inside the one service method, not spread
across callers.

## Final Check

- The service imports no UI and reads no settings; every app choice is an
  input.
- It is made over the folder `app.ts` opened, and opens no store.
- Fallible operations return Results; infallible ones stay plain.
- A factory owns construction or a lifecycle, not convention.
- The capability package picks the implementation where the page runs,
  with one shared type, and its desktop code loads on demand.
- On the desktop, secrets stay in the shell's credentials file, account
  requests go through the relay, and no token or key reaches the page's
  storage.
