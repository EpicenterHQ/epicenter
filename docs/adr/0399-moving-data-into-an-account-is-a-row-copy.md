# 0399. Cross-store copying is an application workflow

- **Status:** Proposed
- **Date:** 2026-09-12
- **Supersedes:** [ADR-0143](0143-account-open-never-consumes-device-data.md) at required sign-in adoption; signing in moves no data.
- **Amends:** [ADR-0351](0351-local-data-removal-is-an-explicit-sign-out-choice.md) at removal scope: account-data removal excludes device-owned Local rows and blobs.
- **Relates:** [ADR-0392](0392-product-boundaries-provide-required-resource-handles.md), [ADR-0401](0401-a-record-names-its-destination-at-creation.md), and [ADR-0419](0419-stores-open-for-explicit-owners-and-compose-live-projections.md).
- **Unbuilt:** Product-specific copy workflows and reference mapping. Whispering's accepted copy workflow is specified in [ADR-0428](0428-whispering-recordings-reference-audio-in-their-containing-store.md).

## Context

The earlier proposal partitioned Local by the signed-in account and placed
Local and Personal inside one App. The current direction opens stores explicitly.
Local belongs to the device profile across account changes; Personal captures
one account. Current stores own blob namespaces.
[ADR-0438](0438-hosted-blobs-have-stable-authority-urls.md) proposes
owner-scoped hosted objects addressed by authority URL. Opening another destination
does not decide which rows or bytes a product should copy.

## Decision

**Applications choose whether copying exists and map content into the receiving store.**

Sign-in, sign-out, and account replacement copy no rows or bytes. No adoption
prompt or framework-level Add/Delete/Keep workflow is required. If a product
offers copying into Personal, it names the destination account and whether
audio is included. Sign-in alone is not confirmation of that transfer.

Local and Personal definitions may differ. A Local recording can retain an
audio BlobId while a Personal row holds only text. The application maps fields
and relationships through ordinary destination row creation; it cannot assume
that spreading a source row produces valid destination data. New row creation
mints its own row identity. This record promises no generic row-copy engine,
exactly-once batch transfer, or automatic merge.

**Blob copying creates a fresh destination identity independently of row identity.**

When a Personal destination needs Local audio, the workflow publishes the
source bytes under the selected Personal owner and receives a new authority
URL under ADR-0438. Current code uses
`destination.blobs.copyFrom(source.blobs, blobId)` and returns a fresh
destination BlobId under ADR-0426. In either shape, copying a row reference
alone does not create destination bytes or grant access. A text-only copy needs
no byte transfer.

The workflow captures source and destination before its first asynchronous
operation. Current store-owned copy follows both stores' lifetimes. The target
publication keeps its selected owner and Account fixed for the operation. A
completed blob publication can survive a later row failure; retain its URL and
destination owner so the caller can retry the row. Neither shape makes row and
byte publication atomic.

A move is a successful copy followed by explicit source deletion. Row deletion
and blob deletion remain separate decisions. Failure or an uncertain copy result
must not trigger source deletion. The workflow states whether originals remain.

## Consequences

Local data stays accessible in the same device profile after account changes.
An account-data removal action must name and limit its scope; it must not erase
device-owned Local data as if that data belonged to the departing account.
Historical account-partitioned bytes remain untouched without a separate
migration decision.

Separate blob-copy calls can create duplicates. A product's row-copy workflow
needs its own retry policy after confirmed byte publication. Products own
missing-file handling, reference mapping, and partial
success presentation; the storage API owns immutable publication and transfer.

## Considered alternatives

- Copy automatically on sign-in: moves device content into an account without
  the product's explicit destination choice.
- Require every Personal row to retain a Local audio reference: imposes a
  device-specific schema on text-only or deliberately hosted material.
- A generic `copyRow` with byte delivery: hides schema mapping and transfer policy.
- Preserve row IDs when copying between stores: confuses two identities
  governed by different creation and conflict rules.
