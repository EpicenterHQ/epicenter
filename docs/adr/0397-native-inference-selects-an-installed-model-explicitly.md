# 0397. Native inference selects an installed model explicitly

- **Status:** Proposed
- **Date:** 2026-09-12
- **Amends:** [ADR-0180](0180-epicenter-has-one-host-owned-active-local-transcription-model.md) at the active-model clause only: a request names an installed model, so "there is no per-request `modelId`" and "an application requests transcription; it does not request a model" are withdrawn. Host-owned residency, model administration in Epicenter Home, the exact model on every transcript, and model files never syncing all stand.
- **Amends:** [ADR-0012](0012-transcription-settings-are-read-at-use-not-mirrored-into-rust.md) at the model-identity boundary, restoring what ADR-0180 withdrew: the model name is again a per-call value, read at use like the language and the prompt.
- **Relates:** [ADR-0363](0363-an-inference-selection-identifies-the-connection-and-model.md), [ADR-0362](0362-inference-connections-do-not-require-runtime-management.md), [ADR-0022](0022-rust-owns-the-models-folder-the-webview-owns-the-catalog.md)
- **Unbuilt:** The picker's "This device" group, and the deletion of `transcribe_recording`. The explicit path exists: `packages/app/src/native-ai.ts` refuses a request without a model id and invokes `transcribe_audio_bytes`, which calls `ModelCache::transcribe_explicit`.

## Context

ADR-0180 was written when a per-request model id was a hidden mutation of one
shared cache: a second app could evict another's warm model on any ordinary
call. It closed that by making one model active and host-owned, and by refusing
an application-facing model list.

The code took a different route to the same safety.
`packages/app/src/native-ai.ts` presents the native engine as an
OpenAI-wire destination over IPC and refuses any request without an explicit
model id, then invokes the `transcribe_audio_bytes` Tauri command, which calls
`ModelCache::transcribe_explicit`. `GET /v1/models` over that transport lists
installed models. The active-model command `transcribe_recording` still exists
in `apps/epicenter/src-tauri/src/transcription/mod.rs` and is re-exported once
in `apps/whispering/src/lib/tauri.tauri.ts`, but nothing invokes it.

Naming a model turned out not to be the hazard. Residency is: how many models
are warm, which one is evicted, and when. That stayed with the host, and
ADR-0180's real protection was never the missing parameter.

## Decision

**A native transcription request names an installed model, and the host refuses
an id it has not installed.**

The request carries the model the way it carries the language and the prompt.
`transcribe_audio_bytes` takes `modelId` and answers with the model that
produced the text, so the ADR-0180 compatibility test still holds: identical
requests naming the same installed model name the same model on the transcript.

**Epicenter Home still administers installs, deletion, and unload policy.**
Downloading, removing, and the idle clock stay host-owned and stay in Home. An
application cannot install a model, delete one, or ask for one to be loaded; it
can only name one that is already installed.

**The installed list is the runtime connection's model list, not a download
inventory.** `GET /v1/models` over the native transport returns installed
models. The picker shows them under "This device" beside account and custom
connections, and a selection there is an ordinary `{ connectionId, model }`
pair (ADR-0363). This withdraws ADR-0180's refusal of an application-facing
listing: a picker that already lists account and custom models is where a
person looks, and hiding the device's models there is the confusing shape, not
the safe one.

**Residency stays private and stays the host's.** Warm count, accelerator,
queueing, and eviction have no application-visible surface, unchanged from
ADR-0180. Naming a model in a request asks for a result, not for a lease on the
machine.

**`transcribe_recording` is deleted.** The command, its generated bindings, its
permission files, and the `transcribe_recording` entry in
`apps/whispering/src/lib/tauri.tauri.ts` go together. One transcription command
remains.

## Consequences

- A machine with three Whisper builds installed can serve a fast model to one
  app and an accurate one to another in the same session. Eviction cost is the
  host's to manage, and a cold load is the visible price.
- ADR-0180's named risk returns in a bounded form: a second app naming a
  different model can cause an eviction the first app did not ask for. It costs
  a reload, not a wrong transcript, because the transcript names its model.
- Whispering stops being special. Its device models arrive through the same
  picker and the same selection field as every other connection, so the fused
  click ADR-0180 complained about is now one click that means one thing.
- The Rust side loses its active-model resolution path for transcription.
  `prewarm_model` still warms a named model.

## Considered alternatives

- **Keep one active model and let the picker set it.** Rejected: selecting in
  Whispering would reassign a machine-wide resource, which is the fused act
  ADR-0180 was written to separate. Naming a model per request separates them
  properly.
- **Expose a `setActiveModel` command to applications.** Rejected: it is the
  hidden machine-wide mutation under a clearer name.
- **App-owned engine or session handles.** Still rejected, for ADR-0180's
  reason: a lease over the shared accelerator carries denial-of-service
  semantics.
- **A separate native model picker in Epicenter Home that applications link
  out to.** Rejected for selection; kept for administration. A person choosing
  between a device model and an account model is making one choice, and two
  pickers make it look like two.
