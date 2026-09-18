# 0398. Every transcription destination speaks the OpenAI wire

- **Status:** Accepted
- **Date:** 2026-09-12
- **Amends:** [ADR-0060](0060-an-inference-connection-is-a-base-url-and-an-optional-bearer-key.md) at its two named transcription exceptions: direct Deepgram and ElevenLabs protocols are unsupported.
- **Relates:** [ADR-0050](0050-the-inference-contract-is-openai-compatible.md) (chat uses the same SDK), [ADR-0404](0404-the-opened-account-owns-application-local-storage.md) (credential ownership), [ADR-0104](0104-hosted-models-are-a-build-time-seed-not-discovered-the-runtime-overlay-is-deferred.md) (authored hosted model inventory)
- **Unbuilt:** A Mistral preset requires verification of the application's full request, including `prompt`; it is not a prerequisite for using a custom compatible endpoint.

## Context

ADR-0060 retained bespoke transcription adapters for Deepgram and ElevenLabs.
Whispering also carried a Mistral adapter, provider settings, and provider-specific
dispatch. Commit `6225905ee9` removed those adapters and moved transcription to
the selected App-owned OpenAI SDK client. It left unused raw HTTP inference
helpers in `@epicenter/client` and a desktop catalog import command.

The product choice is to refuse bespoke provider protocols. Preserving every
vendor would keep the dispatch and configuration that the single SDK boundary
is meant to remove. Retaining stored settings does not make those settings a
usable connection.

## Decision

**Applications make inference requests through actual OpenAI SDK clients.**
The App owns each client's destination, credentials, readiness, and retirement.
A workflow captures an explicit connection and model before sending data.
Transcription uses `client.audio.transcriptions.create`; text completion uses
`client.chat.completions.create`; discovery uses `client.models.list`.
The SDK owns HTTP request and response shapes. `@epicenter/client` retains the
agent-stream reducer, shared workflow errors, and connection presets as data,
but no second set of raw HTTP inference operations.

**A custom connection is a base URL and an optional bearer key, not a provider
adapter.** Account inference uses the captured Account transport. The native
binding translates the supported SDK model-listing and file-transcription
requests into native operations. Client presence does not promise every SDK
endpoint or every model capability.

**Direct Deepgram and ElevenLabs transcription protocols are unsupported.**
There is no provider registry, reserved protocol union, or promised future switch
arm. A compatible endpoint can be configured through Custom URL. Mistral has no
bespoke adapter or preset: compatibility must hold for the particular SDK
operation and request fields used by the workflow.

**Old credentials and settings remain stored but are never adopted.**
Opening an account does not read old provider settings, product-scoped catalogs,
or the old profile-wide catalog. People configure connections and select models
explicitly in the intended account. The host accepts only `add`, `update`,
`remove`, and `reorder`; it rejects the retired `import` command. Version-1
catalog files retain their inert `imports` field when saved. No import mechanism
uses that field.

**The hosted transcription model id is a single authored product constant.**
`HOSTED_TRANSCRIPTION_MODEL` in `@epicenter/constants/ai-providers` is consumed by
`packages/server/src/routes/transcription.ts`,
`apps/api/worker/billing/policies.ts`,
`apps/whispering/src/lib/components/TranscriptionModelPicker.svelte`, and
`apps/vocab/src/lib/state/dictation.svelte.ts`. It does not require a provider registry or discovery
from the gateway.

## Consequences

- Direct Deepgram and ElevenLabs users lose those integrations, including their
  provider-specific request options. A retained key cannot run transcription.
- OpenAI-compatible endpoints remain configurable without adding a vendor module.
  Compatibility with one operation does not establish support for another or
  guarantee that optional fields such as `prompt` are accepted.
- Account isolation, exact workflow selection, hidden desktop keys, and request
  retirement remain App and catalog responsibilities. Removing vendor adapters
  does not remove these boundaries or change SQLite storage guarantees.
- Returning to an account restores its explicitly saved catalog and selections.
  There is no fallback to another account, old key, or similarly named model.

## Considered alternatives

- Keep direct Deepgram and ElevenLabs adapters: rejected because supporting their
  protocols retains a second request and configuration path.
- Reserve a `TranscriptionTarget` union for their return: rejected because it
  preserves an architectural promise the product is refusing.
- Treat all OpenAI-shaped endpoints as fully compatible: rejected because each
  endpoint can support different operations and fields.
- Delete old values or import them automatically: rejected because neither is
  necessary to remove executable compatibility code, and automatic adoption
  violates the captured account's credential boundary.
