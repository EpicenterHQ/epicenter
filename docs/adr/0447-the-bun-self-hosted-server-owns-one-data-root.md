# 0447. The Bun self-hosted server owns one data root

- **Status:** Proposed
- **Date:** 2026-09-24
- **Unbuilt:** Bun Personal sync, direct local hosted-blob storage, and a unified data-root setting.
- **Amends:** [ADR-0066](0066-runtime-portability-is-per-concern-injection-not-a-runtime-object.md) at its S3-only blob rule and self-hosting requirement for an S3 endpoint. Its per-concern composition rule remains.

## Context

The Bun self-hosted entry currently stores passkeys and sessions in SQLite, but
it does not serve Personal sync. Hosted blob routes use an S3-compatible endpoint,
so a person storing bytes on the same machine must also run an object gateway.
That is unnecessary work for the intended one-machine installation. S3 remains
useful for operators who want managed object storage and for the Cloudflare
Worker, which has no persistent local directory.

## Decision

**The supported Bun self-hosted reference is one long-lived process with one
persistent data root.** By default, it keeps auth state, Personal sync state, and
hosted blob bytes beneath that root. It serves the existing auth, sync, and
hosted-blob authority protocol. No S3 gateway, Postgres server, or second
Epicenter process is required for this reference deployment.

The deployment selects its live hosted-blob store when it starts. Bun uses
local durable storage by default and may be configured to use the existing S3
adapter. Cloudflare Workers continue to use the S3 adapter for R2. The server
routes own authorization, stable authority URLs, HTTP reads, and publication
policy; a narrow storage capability owns physical byte operations. Auth and
sync persistence remain their own concerns. There is no unified generic storage
service, automatic fallback, dual write, or runtime backend switch.

The default data root belongs to one active Bun process. An operator may build
a different Hono deployment from the same capabilities, but the reference
configuration makes no active-active or cross-backend migration promise. The
local representation of hosted bytes is an implementation choice to settle by
verification; the contract is durable storage beneath the data root with the
same create-only publication and read behavior as the authority already serves.

## Consequences

An app build still connects to one authority. An operator who changes that
authority must rebuild the app. Changing a live blob backend does not change
saved authority URLs, but the operator must migrate bytes and metadata before
switching backends. Changing the authority origin also requires the old origin
to remain available or saved references to be rewritten. Publication and row
writes are separate operations, with no cross-store transaction.

The operator is responsible for protecting every durable store in the chosen
deployment, including SQLite databases and hosted bytes. A data-root backup is
an operator procedure, not an application backup API or a claim that copying a
live directory is a consistent snapshot. This decision adds no scheduled
backup, restore endpoint, or user data export. An app working copy contains
references to hosted blobs, not their bytes.

The core verifies the Bun local reference and the hosted Worker composition.
Customized combinations may reuse the adapters, but each operator owns the
configuration and operational tests for their deployment.

## Considered alternatives

- Require S3 for every deployment: one adapter in code, but an extra service or
  provider is mandatory for the one-machine operator.
- Replace S3 everywhere with local files and a native R2 binding: removes the
  existing S3 path but makes Bun with managed S3 storage harder and requires a
  separate Worker adapter without a demonstrated need.
- Unify SQLite and blobs behind one storage interface: conflates transactions,
  synchronization, and HTTP object reads that have different guarantees.
- Provide an application backup service now: promises coordinated recovery
  across stores before the operator recovery contract has been designed.
