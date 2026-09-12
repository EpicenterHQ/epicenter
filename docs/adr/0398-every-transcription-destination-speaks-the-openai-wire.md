# 0398. Every transcription destination speaks the OpenAI wire

- **Status:** Proposed
- **Date:** 2026-09-12
- **Amends:** [ADR-0060](0060-an-inference-connection-is-a-base-url-and-an-optional-bearer-key.md) at its two named transcription holdouts: Deepgram and ElevenLabs no longer keep their own config, because they are deleted rather than carried.
- **Relates:** [ADR-0050](0050-the-inference-contract-is-openai-compatible.md) (the same wire rule for chat), [ADR-0056](0056-local-inference-is-a-delegated-engine-behind-the-openai-compatible-seam.md) (the STT route this pins), [ADR-0396](0396-a-connection-transcribes-and-owns-the-four-rules.md) (the verb that speaks it), [ADR-0104](0104-hosted-models-are-a-build-time-seed-not-discovered-the-runtime-overlay-is-deferred.md) (the owned catalog the hosted id belongs to)
- **Unbuilt:** All of it. `apps/whispering/src/lib/services/transcription/cloud/` still holds `deepgram.ts`, `elevenlabs.ts`, and `mistral.ts`, and `apps/whispering/src/lib/data.ts` still declares a nine-member `transcriptionService` select of which five values cannot dispatch.

## Context

ADR-0050 settled one wire for chat. Transcription never got the same sentence,
so Whispering grew a catalog instead: `services/transcription/providers.ts`,
`provider-ui.ts`, `provider-ids.ts`, three cloud adapters, and a
`transcriptionService` select whose members outnumber its working branches.

The catalog exists for two providers. Deepgram's `POST /v1/listen` and
ElevenLabs' `POST /v1/speech-to-text` are genuinely not the OpenAI wire, and
ADR-0060 named them as the correct exceptions. Neither has a named user.
Mistral's `POST /v1/audio/transcriptions` is multipart with `file`, `model`,
and `language`, returning a top-level `text`, which is the OpenAI wire exactly,
so its adapter buys nothing.

Meanwhile the hosted STT model id is written out in several places:
`STT_MODEL` in `packages/server/src/routes/transcription.ts`,
`HOSTED_STT_MODEL` in `apps/api/worker/billing/policies.ts`, `accountModels` in
`apps/whispering/src/lib/components/TranscriptionModelPicker.svelte`, and
`VOCAB_STT_MODEL` in `apps/vocab/src/lib/data.ts`. Four spellings of one pinned
string.

## Decision

**A transcription destination is an inference connection, and every connection
speaks `POST /v1/audio/transcriptions`.** The account gateway, the native
runtime, a custom endpoint, and Mistral are the same call at four base URLs.
Mistral is a connection preset, not an adapter.

**Whispering owns no transcription catalog.**
`apps/whispering/src/lib/services/transcription/` is deleted in full, along with
the `transcriptionService` and `transcriptionModel` fields in
`apps/whispering/src/lib/data.ts`, the five per-provider model keys, the
Deepgram and ElevenLabs secret keys and icons, and their rows in
`ProviderConfigFields.svelte`. `transcriptionLanguage`,
`transcriptionPrompt`, and `dictionary` stay: those are the request, not the
destination.

**A non-OpenAI wire returns as a union, not as a catalog.** If a real user
names a provider that does not speak this wire, the shape is a
`TranscriptionTarget` union and one `switch` inside `transcribe`, the
`connection.transcribe` method of ADR-0396, whose error set already names no
wire. It is not a provider
registry, and it is not a file per vendor.

**The hosted STT model id is spelled once, in `@epicenter/constants`.** One
exported constant replaces `STT_MODEL`, `HOSTED_STT_MODEL`, the picker's
`accountModels` entry, and `VOCAB_STT_MODEL`. It is a product fact we author,
so it belongs beside `AI_MODELS` rather than being discovered from our own
gateway (ADR-0104).

## Consequences

- Whispering loses a nine-member select, four catalog files, three cloud
  adapters, and their tests. What replaces them is one selection field and one
  call.
- Deepgram and ElevenLabs users lose their provider. The loss is named and
  accepted: neither has a known user, and either returns as one `switch` arm
  when one appears.
- Adding a transcription provider stops being a code change. A person adds a
  connection with a base URL and a key, exactly as they do for chat.
- Changing the hosted STT model becomes one edit in `@epicenter/constants`,
  and the gateway's model check, the billing event, and both pickers move
  together. Today they can drift apart.
- Verify before deleting `mistral.ts` that Mistral tolerates an extra `prompt`
  field, since the OpenAI request carries one and Mistral's documented body
  does not name it.

## Considered alternatives

- **Keep the Deepgram and ElevenLabs adapters behind the same operation.**
  Rejected: two adapters with no users cost a dispatch branch, four catalog
  files, and a select whose members mostly fail.
- **Keep a provider catalog in Whispering as the place a person picks a
  transcriber.** Rejected: the picker already lists connections, and a second
  list of vendor names beside it teaches that a provider is a different kind of
  thing from a connection.
- **A `Transcriber` interface each provider implements.** Rejected: one
  implementation is not an interface, and the second one would be a `switch`
  arm either way.
- **An `openai-adapter.ts` beside a `deepgram-adapter.ts`.** Rejected for the
  same reason ADR-0060 rejected the hosted-versus-custom branch: the OpenAI
  wire is the wire, not one option among peers.
- **A universal transcription registry keyed on provider id.** Rejected: it is
  the catalog this record deletes, with an indirection added.
- **Discover the hosted STT model from the gateway.** Rejected by ADR-0104: the
  hosted catalog is authored by us, and fetching it back is re-learning what we
  shipped.
