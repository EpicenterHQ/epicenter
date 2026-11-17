---
name: services-layer
description: Design UI-free services with explicit inputs, Result fallibility, and lifecycle factories. Use when creating services, choosing a provider for a request, or maintaining Whispering's browser and desktop services.
metadata:
  author: epicenter
  version: '5.0'
---

# Services Layer

Grounded in Whispering (`apps/whispering/src/lib/app.ts` and
`whispering.svelte.ts`) and `@epicenter/ai`'s `customEndpoints()`
(`connection-keys.ts`). Trace a service from its caller to the capability it uses.

## Product Sentence

A service owns a UI-free capability. Its caller supplies app choices. Fallible operations return Results.

## Boundary

Services may perform I/O and own service-local state. They stay free of UI
and app policy:

- no reads of Svelte state, settings notes, toasts, or reporting;
- credentials, endpoints, models, paths, and the store come in as inputs;
- domain data and tagged errors come out, not presentation copy;
- a capability's browser and desktop implementations share one type.

Pass the service the storage capability its caller selected. In [Whispering](../../../apps/whispering/src/lib/app.ts), `createMicrophoneDevice({ files: folder.audio, recorder: microphone })` records into the same audio store its pages read.

## Whispering's browser and desktop services

Whispering passes the same recorder interface to its capture service on both surfaces. Its desktop shell holds credentials and relays authenticated requests. For the specific stores, commands, and browser equivalents, see [Whispering’s platform services](references/service-organization-platforms.md). For implementation selection and lazy desktop imports, see [platform seams](../platform-seams/SKILL.md).

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
factory when it owns real construction inputs or a lifecycle: Whispering’s
`createMicrophoneDevice` takes the selected recorder and audio store at construction. Each successful `start` returns a session whose `stop` finishes that specific recording. Do not add `create*` only to
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
- If a service writes to a store, its caller supplies the intended store.
- Fallible operations return Results; infallible ones stay plain.
- A factory owns construction or a lifecycle, not convention.
