# 0618. Epicenter hosts no AI service

- **Status:** Proposed
- **Date:** 2026-10-19
- **Supersedes:** [ADR-0049](0049-inference-is-its-own-box-the-daemon-never-infers.md), [ADR-0050](0050-the-inference-contract-is-openai-compatible.md), [ADR-0054](0054-an-inference-backend-is-the-metered-gateway-or-a-custom-server.md), [ADR-0100](0100-ai-credits-are-product-units-and-the-charge-shape-follows-when-cost-is-known.md), [ADR-0104](0104-hosted-models-are-a-build-time-seed-not-discovered-the-runtime-overlay-is-deferred.md), [ADR-0557](0557-an-ai-connection-is-a-row-in-so-epicenter-whose-key-stays-in-this-machines-keychain.md), [ADR-0564](0564-an-ai-connections-endpoint-is-stored-with-its-key-not-in-its-row.md), [ADR-0579](0579-epicenter-never-deletes-a-model-from-the-shared-hugging-face-cache.md), and [ADR-0580](0580-a-local-model-is-pinned-by-commit-and-content-hash-under-a-frozen-id.md), Epicenter's inference: Epicenter runs no inference or transcription gateway, bills no AI credits, and keeps no local model, and an AI connection survives only as the CLI's bring-your-own-key keychain entry.
- **Amends:** [ADR-0549](0549-every-epicenter-resource-accepts-only-opaque-access-tokens-from-one-oauth-authorization-server.md) at the `ai` scope and the `/v1/*` rows of its resource and scope tables: the API serves no `/v1/*`, and no `ai` scope exists; [ADR-0565](0565-a-refresh-token-keeps-its-grants-scopes-and-only-each-access-token-is-narrowed-to-its-audience.md) at `ai` in its scope lists and audience table: no `ai` scope exists; [ADR-0398](0398-every-transcription-destination-speaks-the-openai-wire.md) at "Account inference uses the captured Account transport" and "The hosted transcription model id is a single authored product constant": no Epicenter account inference exists, and `HOSTED_TRANSCRIPTION_MODEL` goes.
- **Relates:** [ADR-0611](0611-epicenter-is-only-the-data-layer-its-apps-reach-over-git.md) (Epicenter is only the data layer).
- **Unbuilt:** all of it: deleting `/v1/*`, the AI credit billing, the `ai` scope, and the `epicenter` connection in `epicenter send`. Whether `send` keeps its `account` target, which carried a desktop page's account requests, is not decided. The app-side connection picker lives in `packages/ai` (`@epicenter/ai`), which Whispering, Vocab, and Todos import, as do `apps/epicenter` and `packages/cli`; those dependencies are mapped before any of it is deleted. What happens to existing paid plans and credit balances is not decided.

## Context

Epicenter's API serves an OpenAI-compatible inference and transcription
gateway at `/v1/*` (`mountInferenceApp` in
`packages/server/src/routes/inference.ts`, `mountTranscriptionApp` in
`packages/server/src/routes/transcription.ts`), behind the `ai` scope
(`packages/server/src/auth/oauth-policy.ts`), metered in AI credits
([ADR-0100](0100-ai-credits-are-product-units-and-the-charge-shape-follows-when-cost-is-known.md))
through `apps/api/worker/billing/catalog.ts`. An app's inference backend is
that gateway or a custom server
([ADR-0054](0054-an-inference-backend-is-the-metered-gateway-or-a-custom-server.md)).
On the desktop, an AI connection was a row whose key stays in the keychain
([ADR-0557](0557-an-ai-connection-is-a-row-in-so-epicenter-whose-key-stays-in-this-machines-keychain.md),
[ADR-0564](0564-an-ai-connections-endpoint-is-stored-with-its-key-not-in-its-row.md)),
reached through the CLI's `auth key` and `send`
(`packages/cli/src/ai-commands.ts`), and the host managed local models
([ADR-0579](0579-epicenter-never-deletes-a-model-from-the-shared-hugging-face-cache.md),
[ADR-0580](0580-a-local-model-is-pinned-by-commit-and-content-hash-under-a-frozen-id.md)).

Epicenter is now only the data layer its apps reach over Git
([ADR-0611](0611-epicenter-is-only-the-data-layer-its-apps-reach-over-git.md)).
A gateway, a credit ledger, and a model cache are none of Git, the access
list, or the library.

## Decision

**Epicenter hosts no AI service.** Deleted: the `/v1/*` routes with
`packages/server/src/routes/inference.ts` and
`packages/server/src/routes/transcription.ts`, the AI credit billing in
`apps/api/worker/billing/`, the `ai` scope in
`packages/server/src/auth/oauth-policy.ts` and
`apps/api/worker/oauth-registrations.ts`, and `HOSTED_TRANSCRIPTION_MODEL`.
Cost: an app that used the hosted gateway needs a connection of its own
before it can transcribe or chat.

**AI is an app concern.** An app connects to a provider, to Ollama, or to a
custom URL itself, and keeps that connection the way it keeps any other
setting. The Git service and `@epicenter/data` neither store nor broker a
connection or a key.

**The CLI keeps its bring-your-own-key commands and drops its hosted
path.** `packages/cli/src/ai-commands.ts` keeps
`epicenter auth key set|remove|state <id>`, which keeps an endpoint and its
key in this machine's keychain, and `epicenter send`, which sends one
request to that endpoint with that key. Deleted: the `epicenter` connection
kind, which `send` sent with Epicenter's access token (`EpicenterAccess`).

**A hosted AI project may come later, separate from the data layer.** It
may bring back a hosted path to the CLI, and adds nothing to the Git
service or `@epicenter/data`.

## Consequences

- Whispering's and Vocab's hosted options go; a person sets up a provider
  key, Ollama, or a custom URL in the app.
- Vocab's chat runs `@epicenter/agent` over `openEpicenterInference` from
  `@epicenter/ai` (`apps/vocab/src/lib/inference.ts`), the hosted inference
  deleted here, so Vocab's later port to `@epicenter/data` also moves its
  chat to a connection the app keeps itself.
- The API's audience serves no inference, so a token for it carries no
  scope that spends money.
- An agent on a Mac still sends AI requests through `epicenter send` with a
  key kept by `epicenter auth key`, to a provider, Ollama, or a custom URL,
  never to Epicenter.

## Considered alternatives

- **Hosted AI as another grant scope.** The Git service's access list then
  meters and bills inference, and every change to AI pricing touches the
  data layer.
- **Keep the gateway beside the data layer in one deployment.** One
  service then carries two products with two failure modes and two billing
  stories.
