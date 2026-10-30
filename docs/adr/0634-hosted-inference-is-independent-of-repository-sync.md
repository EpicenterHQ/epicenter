# 0634. Hosted inference is independent of repository sync

- **Status:** Accepted
- **Date:** 2026-10-19
- **Supersedes:** [ADR-0618](0618-epicenter-hosts-no-ai-service.md), its removal of hosted inference, transcription, the `ai` scope, AI billing, and the CLI's hosted request path.
- **Amends:** [ADR-0611](0611-epicenter-is-only-the-data-layer-its-apps-reach-over-git.md) at its data-only product scope and bring-your-own-key-only CLI path; [ADR-0614](0614-a-browser-app-is-identified-by-its-origin.md) at every browser service grant requiring a repository target; [ADR-0619](0619-every-byte-epicenter-keeps-is-a-git-object-a-working-file-an-access-list-row-or-a-cache.md) at applying the repository inventory to inference usage or billing records; and [ADR-0627](0627-every-change-to-the-data-model-is-checked-against-nine-principles.md) at excluding hosted inference from Epicenter's product scope.
- **Relates:** [ADR-0549](0549-every-epicenter-resource-accepts-only-opaque-access-tokens-from-one-oauth-authorization-server.md) (resource audiences), [ADR-0564](0564-an-ai-connections-endpoint-is-stored-with-its-key-not-in-its-row.md) (endpoint and key), and [ADR-0633](0633-apps-open-local-data-before-connecting-services.md) (account-free local data).
- **Unbuilt:** independent inference-only consent for the planned clients, its integration into standalone apps, and the included allowance's amount, renewal, eligible models, and limit behavior.

## Context

ADR-0618 removed inference because the proposed Epicenter product contained
only repository storage and its clients. Its deletion plan is not applied:
`apps/api/worker/index.ts` still mounts `mountInferenceApp`,
`mountTranscriptionApp`, and `mountBillingApi`. The gateway routes live in
`packages/server/src/routes/inference.ts` and `transcription.ts`. The
hosted deployment composes them with policies from
`apps/api/worker/billing/`.

The local-first toolkit and optional service bundle restore hosted AI as a
product capability. Repository access and inference spending authorize
different operations. Someone may use GitHub for text synchronization and
Epicenter for transcription, or Epicenter synchronization with a local model.

## Decision

**Epicenter offers hosted inference and transcription with a bounded included allowance.**
Retain the existing gateway, `ai` authorization scope, hosted request path,
and billing integration. The allowance is an account-level service benefit
available from authorized apps across devices. Its quantity and commercial
terms are separate product configuration, not a Git or file-format rule.
Earlier records retired by ADR-0618 are not automatically restored in full.

**Inference access and repository access are independent permissions.**
An app can authorize inference without choosing or creating a repository.
An inference token authorizes the AI operation through the API audience;
it grants no Git access. Repository consent still names a repository ID
and authorizes only that resource's allowed operations. Signing in for
inference does not connect, upload, or synchronize a dataset.

**Apps choose how they perform AI work.** An app can offer Epicenter,
another provider, or a supported local model. Apps own prompts, execution,
native capabilities, and which results they save. `@epicenter/data` and
the Git service neither select models nor broker keys or inference requests.
Removing inference access or reaching an allowance limit does not stop
local opening, saves, or separately authorized Git synchronization.

**A request sends its selected inputs; inference is not attachment synchronization.**
Whispering can send a local recording for transcription and save the returned
text without creating a synchronized copy of the recording. The account's
inference access follows the person across devices. Original audio remains
device-local under ADR-0621. Durable media hosting needs a separate decision.

**Billing stays hosted-only in `apps/api/worker/billing/`.**
Do not move its catalog, credit accounting, or provider integration into
the data library, a shared package, or the self-hosted deployment. Shared
request handlers can remain billing-agnostic; deployment policies meter
hosted requests. Credentials stay outside synchronized data files. No
shared desktop model manager or connection registry is restored.

## Consequences

- Existing gateway and billing code are retained rather than deleted as
  part of the data-layer migration. Current paid plans and balances are
  not retired by that migration.
- Hosted AI requires service operations, cost control, usage accounting,
  and a defined allowance. Those responsibilities remain separate from
  repository storage and synchronization failures.
- An inference request authorizes the chosen processing, not a durable
  audio library or automatic access to all repository contents.
- Local AI and bring-your-own-provider options remain application features.
  Supporting them does not require the Epicenter desktop runner.

## Considered alternatives

- **Remove hosted AI under ADR-0618.** Keeps a smaller hosted product but
  removes the ready-to-use inference option chosen for Epicenter's apps.
- **Bundle inference authorization into repository consent.** Forces
  inference-only users to choose storage and mixes spending with file access.
- **Make the data library dispatch inference.** Couples local data lifetime
  to providers, credentials, pricing, and network request behavior.
