# 0424. Runtime transcription calls the host directly

- **Status:** Accepted
- **Date:** 2026-09-22
- **Amends:** [ADR-0398](0398-every-transcription-destination-speaks-the-openai-wire.md) at its native transport: network destinations retain actual OpenAI SDK clients; native transcription no longer implements a synthetic HTTP endpoint.
- **Implementation:** Direct runtime transcription and its caller/picker path are implemented. The native SDK transport is removed; native acceptance uses the direct API. Physical microphone acceptance is tracked separately from file transcription.

## Context

The former `packages/app/src/native-ai.ts` accepted SDK requests, parsed multipart
audio, invoked Rust, and constructed HTTP responses for the SDK to decode. Two
native operations, model listing and transcription, imitated a network server.
The SDK also exposed methods the native implementation could not execute.

## Decision

The runtime transcriber exposes model listing and transcription directly. Its
implementation validates inputs and host results around typed IPC. It does not
own a native engine, change the machine's active model, or emulate HTTP.

The public call shape is:

```ts
const runtime = await openRuntimeTranscriber();
if (runtime) {
  const result = await runtime.transcribe(
    { audio, model, language, prompt },
    { signal },
  );
}
```

The constructor is importable in browser and desktop builds. It returns `null`
only when the environment supplies no provider. An available provider with no
installed models returns an empty successful model list. Broken bindings,
discovery failures, and failed requests remain failures. Opening need not load
a model or prove future request success. Discovery does not select a fallback.

Requests name an exact installed model. IDs are opaque strings from the host's
`listModels()` response, rather than a second catalog encoded as TypeScript
literal types. The host validates membership and installation at execution;
stale or unknown IDs fail without choosing a replacement. The active-model flag
is metadata, not permission to substitute a different model. Explicit requests
do not change the host's active-model setting. The host owns model files and compute.
Expected transcription failures use typed Results; unexpected defects retain
an explicit exception boundary. The result preserves text and useful host
metadata without fabricating HTTP response fields. Empty audio is a successful
empty transcript, distinct from failure or an absent provider.

Caller cancellation stops admission and suppresses delivery after cancellation.
Already admitted noninterruptible compute remains host-owned until it settles.
Page replacement cannot let old work act on a successor page or account. A
resource `close()` may retire access and settle admitted work; it does not unload
the shared engine. Rechecking state cannot replace host ownership enforcement.

Network inference retains actual OpenAI SDK clients and their existing captured
authentication, destination, streaming, and request-lifetime guarantees. Native
runtime identity no longer derives from a fake base URL. Saved workflow
selection must still identify the exact source and model; changing that identity
does not authorize rewriting persisted selections or choosing another source.

Application transcription operations compose the native and network paths.
They receive audio and a captured destination, then retain the resulting text
through later storage failures. Recording controllers and UI event handlers
do not invoke Rust directly. This is one native boundary, not a provider registry
or a universal wrapper around the network SDK.

## Consequences

Delete native HTTP routing, multipart decoding, synthetic responses, and the
native fake origin after migrated callers pass verification. The native path
leaves the network response-body wrapper. Keep native validation, cancellation,
and host cleanup. Keep network SDK behavior, including streams.

Transcription has two execution paths. The benefit is removing protocol
translation from native compute. An app that needs chat uses a network client;
the runtime transcriber does not claim to provide chat.

## Considered alternatives

- Keep the native SDK transport: one caller shape requires synthetic HTTP and
  exposes unsupported operations.
- Replace every inference source with `complete` and `transcribe`: makes this
  package maintain a second network API and narrows future apps unnecessarily.
- Call raw `invoke` from each application: repeats result validation and lets
  callers invent conflicting cancellation and ownership rules.
- Treat native failure as absence: hides broken installations and can redirect
  data if a caller selects another provider.

## Verification

Prove browser import and absence, successful empty discovery, discovery failure,
exact model selection, malformed host results, empty audio, cancellation before
dispatch, and draining after admission. Exercise page replacement during native
work. Recheck network SDK streaming and authentication independently. Unit tests
with injected IPC do not establish installed-host or physical-microphone behavior.

Implementation evidence and remaining environment limits are recorded in the
[clean-break report](../reports/20260922-runtime-transcriber-clean-break.md).
