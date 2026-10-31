---
name: services-layer
description: Apply Epicenter's service-boundary patterns for UI-free capabilities, explicit inputs, Result fallibility, lifecycle factories, and per-build implementations behind a `#platform/*` seam. Use when creating or refactoring an app's services or their contract, provider or connection dispatch, or a desktop service over the shell, the keychain, or the account.
metadata:
  author: epicenter
  version: '4.0'
---

# Services Layer

Grounded in Whispering's `#platform/services` (`apps/whispering/src/lib/platform/`)
and Vocab's `#platform/connections`. Read the app's own `package.json`
"imports" and its platform types file before changing a service.

## Product Sentence

A service owns a UI-free capability; the app passes in what it decides,
fallible operations return Results, and the build picks one implementation
per variant through one `#platform/*` seam.

## Boundary

Services may perform I/O and own service-local state. They stay free of UI
and app policy:

- no reads of Svelte state, settings notes, toasts, or reporting;
- credentials, endpoints, models, paths, and the store come in as inputs;
- domain data and tagged errors come out, not presentation copy;
- both leaves of the seam export the same contract.

A service never chooses or opens the store. It is constructed over the
client the variant's root opened: Whispering's
`CreateServices = (client: Client<Whispering>) => WhisperingServices`,
called once in `createWhispering` (`whispering.svelte.ts`), so a recording
lands in the same store the pages read.

## Per-build implementations

One seam, one type, two leaves (see the `platform-seams` skill):

```txt
#platform/services
  default → src/lib/platform/browser.ts        the WebView microphone, fetch, localStorage
  tauri   → src/lib/platform/services.tauri.ts the shell's microphone, send_request, the keychain, local models
```

Each leaf is `export const createServices: CreateServices = (client) => ({ … })`,
annotated with the shared type in `platform/types.ts`. Shared code imports
`createServices` from `#platform/services` and never checks `isTauri()`.

On the desktop, a service reaches native code only through the app's shell
and the shared crates, never through a credential in the page:

- **Secrets** go to the OS keychain through `epicenter-account`: `keychain`
  from `@epicenter/auth/tauri` (`keychain_get`, `keychain_set`). Whispering
  keeps both connections as one entry; Vocab keeps each key under its
  connection's id and the endpoint list in `connections.md` in AppData.
  Never put a key in a settings note, the data folder, or WebView storage.
- **The account** is a relay: requests go through `account.fetch`, which
  the shell sends with `account_fetch` and a token the page never sees.
- **Other requests** to a custom endpoint leave through the shell
  (Whispering's `shellFetch` over `send_request`), so no endpoint needs a
  CORS rule for the window's origin.
- **A root-scoped native command** (the recorder, local transcription)
  names the data folder by `rootOf(device)` from `@epicenter/folder/tauri`;
  the shell refuses a root the window did not open.

Read [service organization and platform variants](references/service-organization-platforms.md)
when adding or moving a service.

## Model Fallibility Honestly

Use `Result<T, E>` for an operation that can fail in ordinary use. Adapt
throwing platform or library calls with the `error-handling` skill.

Do not fake a Result for an infallible in-memory action or a cleanup. Errors
belong to the layer that understands the failure: pass lower-layer tagged
errors through (`TranscriptionError`, `RecorderError`), and define a
service-local variant only for a failure the service owns.

## Direct Object Or Factory

Default to a plain object when construction has no input or lifecycle. Use a
factory when it owns real construction inputs or a lifecycle: Whispering's
`createServices(client)` takes the store, and its capture device
(`createShellMicrophone`, `createWebViewMicrophone`) owns one recording
session at a time with its stop and recovery. Do not add `create*` only to
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
- It is constructed over the client the root opened, and opens no store.
- Fallible operations return Results; infallible ones stay plain.
- A factory owns construction or a lifecycle, not convention.
- The build picks the implementation through one `#platform/*` seam, with
  one shared type.
- On the desktop, secrets go through the keychain, account requests through
  the relay, and no token or key reaches the page's storage.
