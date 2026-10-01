# 0401. A record names its destination at creation

- **Status:** Proposed
- **Date:** 2026-09-12
- **Relates:** [ADR-0392](0392-product-boundaries-provide-required-resource-handles.md), [ADR-0399](0399-moving-data-into-an-account-is-a-row-copy.md), and [ADR-0419](0419-stores-open-for-explicit-owners-and-compose-live-projections.md).
- **Unbuilt:** Product migration to explicit store destinations and scope-specific recording schemas. No destination picker is required.

## Context

An aggregate App and a selected library once hid the write destination.
Independent Local and Personal stores make ownership explicit. A product may
open both, but each workflow still needs one fixed destination for each write.

## Decision

**A workflow captures its destination before asynchronous work and never retargets it.**

The application can use a fixed store, the current view, or a destination
control. It resolves that policy before creation and calls that store's table
handle. The framework requires neither a picker nor a Personal default.
Missing account access never silently redirects an account write into Local.

The table handle supplies store identity; a redundant destination field on
every row is unnecessary. View changes cannot redirect a pending write.
If the destination closes before row-write admission, the write refuses and
already committed bytes remain intact.

Recording captures `local.blobs` through its recorder before microphone
acquisition. Successful Stop publishes local bytes and returns their BlobId.
The application then creates a row in the schema its workflow selected.
A Local recording row can retain the ID. A Personal workflow can save text
without audio, or explicitly publish and reference a Personal blob placement.
No recording row is required during capture. No chosen row destination causes
automatic upload or field conversion.

The recorder and row destination may belong to different stores. Each retains
its own admission and lifetime. Closing Local drains admitted Stop publication
through the recorder's private writer; that does not authorize a row write into
a closed Personal store. A later row failure must preserve the saved ID.

Reading is a separate choice. A product may show several stores, retaining the
owning handle for each record's actions. UI context supplies ready handles;
it does not change destination or make writes transactional across stores.

## Consequences

A caller already holding its destination table needs no extra destination
selector. Applications may require sign-in or hide Local while the SDK keeps
Local device-owned. Account changes neither move Local data nor select another
Local namespace.

Cross-store copying remains optional application work under ADR-0399.
Separate schemas express different product material without an owning blob
field, framework copy controller, or mandatory transfer.

## Considered alternatives

- Resolve the destination after capture: account or view changes can redirect work.
- Require a destination picker: exposes an implementation choice in every product.
- Fall back to Local after Personal failure: silently changes the requested owner.
