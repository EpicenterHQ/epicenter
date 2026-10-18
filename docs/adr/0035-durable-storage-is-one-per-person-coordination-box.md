# 0035. Durable storage is one per-person coordination box: an app-blind anchor and store

- **Status:** Accepted
- **Date:** 2026-06-18
- **Note (2026-06-29):** iroh, the dependency, was deleted in the device-channel transport wave. This durable-storage decision is transport-agnostic and stands, but the two iroh-specific illustrations below (the **Iroh** deployment-mode bullet under Decision, and the iroh-blobs content-addressing parenthetical under Consequences) name a mechanism that is no longer in the repo. The relay/anchor split they sketch is now pursued without iroh: the per-user relay floor is the first step toward a self-hostable relay (see [ADR-0068](0068-privacy-is-a-deployment-not-a-product-feature.md)), and content-addressing remains a store option over the existing S3 contract, not iroh-blobs.

## Context

ADR-0024 split three runtime roles: a blind relay that moves packets, an anchor that keeps durable Y.Doc state alive, and an app-aware worker beside it. Two forces have since sharpened the picture. Large binaries like audio cannot ride a CRDT (the Yjs threat model and Epicenter's own 2MB/5MB caps rule it out, the same finding behind ADR-0004's asset work), so they need durable storage of their own. And the always-on box that holds a person's docs is, for almost everyone, a single machine: a hosted Epicenter room today, a Mac Studio under Iroh later. The open question was whether to model that as a general mesh or commit to the shape people actually run.

## Decision

A person's durable state lives in one coordination box that exposes two app-blind storage roles. The **anchor** keeps Y.Doc state; the **store** keeps blobs (`put`, `get`, `has` by reference, where the doc carries the reference and never the bytes). Both are app-blind and never think. The store is the binary sibling of the anchor, not a new kind of thing. The two co-locate by default and stay two contracts, so a later split (docs on the cloud, audio on a home box) costs a reference field, not a redesign.

This box is the center of a star, and the star is the one supported topology. Every device and every worker syncs through one coordination box per person. Epicenter builds no multi-box federation, no anchor election, no cross-center routing. Two deployment modes implement the same star:

- **Cloudflare:** the coordination box is Epicenter Cloud. Relay and anchor are fused in one Durable Object; the store is R2. Epicenter holds the durable plaintext (ADR-0004).
- **Iroh:** the coordination box is the user's own machine. The relay splits off as a blind, hosted reachability helper while the anchor and store move to the user's box, which holds the plaintext under its own custody. Devices on one LAN talk directly; the relay only brokers reach.

Workers are independently placeable spokes, not part of the box. A worker connects through the coordination box as a peer, observes the rows designated to the agent it answers as, runs inference and actions, and writes results back. It carries no storage and no routing, so a second, more powerful machine can be a pure worker host without becoming a second center, and the phone never needs to know it exists. The coordination box stays dumb even in the common case where it also runs one worker.

## Consequences

- The role list is now five: relay (moves bytes), anchor (keeps docs), store (keeps blobs), worker (thinks), and the agent (the durable address a worker answers as, ADR-0025). Three never think, one thinks, one is a name.
<!-- doc-path-check: ignore-next-line -->
- Self-hosting is one Bun process that re-implements the same contracts. A Durable Object's embedded SQLite becomes Bun plus disk, R2 becomes the local filesystem, the managed worker becomes the user's own daemon. The interface is the boundary; the backend swaps (per `specs/20260522T220000-api-runtime-portability.md`).
- "Star" is a deployment fact, not a contract apps depend on. Apps talk to roles, so the topology can gain direct peer links (LAN shortcuts, a future mesh) without an app rewrite.
- Refusing federation deletes the hardest problems up front: no split-brain across competing durable replicas, no consensus on which box owns a doc, no cross-center merge. The cost is that a person with several always-on boxes still names one as the coordination center, and the others are worker spokes.
- The blob reference type is left to the trust model, not fixed here. Link-shared media keeps the capability URL of the asset work (the unguessable id is the credential); intra-account transport between an owner's own devices can use a content hash (iroh-blobs is natively content-addressed), because membership, not URL secrecy, gates the read there.

## Considered alternatives

- **Grow the anchor to hold blobs.** Rejected: it redefines the one role whose whole value is a narrow, app-blind contract, and it hides the docs-here-blobs-there custody choice the store makes visible.
- **A general mesh of equal boxes.** Rejected: it pays for federation, election, and cross-center merge that almost no one needs, to model a shape almost no one runs. One coordination box per person is the honest default.
- **Fold blob transport into the relay.** Rejected: the relay is blind and transient, but blobs need durable storage that survives the producer going offline, which is the store's job.
