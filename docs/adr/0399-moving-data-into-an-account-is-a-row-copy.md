# 0399. Cross-store copying is an application workflow

- **Status:** Proposed
- **Date:** 2026-09-12
- **Supersedes:** [ADR-0143](0143-account-open-never-consumes-device-data.md) at required sign-in adoption; signing in moves no data.
- **Amends:** [ADR-0351](0351-local-data-removal-is-an-explicit-sign-out-choice.md) at removal scope: account-data removal excludes device-owned Local rows and blobs.
- **Relates:** [ADR-0392](0392-product-boundaries-provide-required-resource-handles.md), [ADR-0401](0401-a-record-names-its-destination-at-creation.md), and [ADR-0419](0419-stores-open-for-explicit-owners-and-compose-live-projections.md).
- **Unbuilt:** Product-specific copy workflows and reference mapping. This record requires no Whispering migration or transfer UI.

## Context

The earlier proposal partitioned Local by the signed-in account and placed
Local and Personal inside one App. The current direction opens stores explicitly.
Local belongs to the device profile across account changes; Personal captures
one account. Each store owns its blob namespace. Opening another destination
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

**Blob copying preserves blob identity independently of row identity.**

When the destination needs audio, the workflow explicitly uses
`destination.blobs.copyFrom(source.blobs, blobId)` for a supported pair under
ADR-0372. It preserves the BlobId and exact bytes. Copying a row reference alone
does not create a destination placement or grant access. A text-only copy needs
no byte transfer. If a reference points outside its store's own blob namespace,
it retains enough credential-free location information under ADR-0426.

The workflow captures source and destination before its first asynchronous
operation. Closing either store cancels and settles its admitted copy without
closing the other store. A completed blob copy can survive a later row failure;
retain the copied ID and destination scope so the caller can reconcile that
outcome. Store ownership does not make row and byte publication atomic.

A move is a successful copy followed by explicit source deletion. Row deletion
and blob deletion remain separate decisions. Failure or an uncertain copy result
must not trigger source deletion. The workflow states whether originals remain.

## Consequences

Local data stays accessible in the same device profile after account changes.
An account-data removal action must name and limit its scope; it must not erase
device-owned Local data as if that data belonged to the departing account.
Historical account-partitioned bytes remain untouched without a separate
migration decision.

Same-ID blob retries can be idempotent after verified equality while a product's
row-copy workflow still needs its own retry policy. Neither contract substitutes
for the other. Products own missing-file handling, reference mapping, and partial
success presentation; the storage API owns immutable publication and transfer.

## Considered alternatives

- Copy automatically on sign-in: moves device content into an account without
  the product's explicit destination choice.
- Require every Personal row to retain a Local audio reference: imposes a
  device-specific schema on text-only or deliberately hosted material.
- A generic `copyRow` with byte delivery: hides schema mapping and transfer policy.
- Preserve row IDs because blob IDs survive copying: confuses two identities
  governed by different creation and conflict rules.
