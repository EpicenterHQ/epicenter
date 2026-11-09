# 0069. Epicenter is one runnable program (the star) plus a la carte services addressed by base URL and token

- **Status:** Accepted
- **Date:** 2026-06-24
<!-- doc-path-check: ignore-next-line -->
- **Relates:** [ADR-0068](0068-privacy-is-a-deployment-not-a-product-feature.md) (privacy is which deployment runs the program; this names what a "deployment" is), [ADR-0035](0035-durable-storage-is-one-per-person-coordination-box.md) (the star: anchor, store, worker, relay roles), [ADR-0050](0050-the-inference-contract-is-openai-compatible.md) / [ADR-0054](0054-an-inference-backend-is-the-metered-gateway-or-a-custom-server.md) (inference is an OpenAI-compatible endpoint chosen by base URL) / [ADR-0067](0067-auth-owns-the-session-endpoint-the-data-client-is-owner-scoped.md) (the owner-scoped client and the `{baseUrl, apiKey?}` floor); the in-flight work and gap ledger live in `specs/20260624T223835-privacy-is-a-deployment-self-host-and-relay-anchor-gradations.md`.

## Context

ADR-0068 settled that privacy is which deployment runs the program, but left "what is a deployment" implicit, and a design pass kept trying to model a privacy "middle rung" (own your data but borrow Epicenter's relay). Grounding the code dissolved the ladder. Inference is already a `{baseUrl, apiKey?}` choice pointable at Epicenter or a local Ollama (ADR-0050/0054/0060), and blob URLs are an owner-scoped service reached by token (`epicenter blobs add` against a running server), neither of which is part of the sync topology. The forcing question: is there a spectrum of deployments, or one custody fork plus a menu of callable services?

## Decision

Epicenter is two kinds of thing, and conflating them is what produced the false ladder.

1. **The star: one runnable program that holds your data.** It is the anchor (the always-on holder of the Y.Doc), the store (blobs), sync, and identity/auth, composed into one process. The star is the unit of deployment and the entire privacy question: Epicenter runs it (hosted) or you run it (self-host). ADR-0068's binary is exactly "who runs the star."

2. **Services you call.** Inference and blob-URL minting are each addressed by `{baseUrl, token?}`, each optional, each pointable at Epicenter or at your own. A service is never part of the star's topology; it only ever sees the one payload you hand it (a prompt to infer, a blob to store). Pointing a service at a different base URL is not moving custody.

Self-host means running the star. Either deployment can call the services. There is **no "partial self-host" rung**, because moving a service endpoint is not moving your data's home. The one sentence: *Epicenter is a program you run plus services you call; self-host runs the program, either deployment calls the services, and privacy is only about who runs the program.*

## Consequences

- **Privacy is binary (who runs the star), not a spectrum.** The retired "own-anchor, blind-relay middle" was a service-endpoint choice mis-modeled as a custody change. The honest gradient is the single custody fork plus an orthogonal, already-config-driven service menu, not a tier ladder (this does not reopen ADR-0068: the hosted product still ships zero privacy settings; a self-hoster composes services by pointing URLs, which is how the code already works).
- **The service boundary is uniform: `{baseUrl, token?}`** (the ADR-0067 floor). Inference points at Epicenter's metered gateway (the audience-scoped bearer is attached) or at your own endpoint (bare fetch). Blob URLs come from `epicenter blobs add` against a running star.
- **Honest footnote on renting the blob service.** A blob URL's ticket is minted by a running star, and the bytes land in that star's S3. Renting Epicenter's blob service therefore puts those bytes in Epicenter's R2, readable by Epicenter, the same trust as hosted docs. A self-hoster who wants media private points the store at their own S3 endpoint. A service sees what you hand it; for blobs that payload is the bytes.
- **Only the star needs packaging.** Self-host delivery is the Bun star binary (ADR-0066); services need no packaging because they are called, not shipped.
- **What this forecloses:** modeling deployments as a privacy spectrum, and folding inference or blobs into the star's identity so the self-hoster loses the a la carte choice the code already supports.

## Considered alternatives

- **A privacy "rung ladder" (hosted / own-anchor-blind-relay / full self-host).** Rejected: the middle rung was a service-endpoint swap, not a custody change. It mis-counted one axis as two and invented a persona for a configuration that is just "point a URL elsewhere."
- **Fold inference and blobs into the star as built-in subsystems.** Rejected: they are already token-addressed and pointable elsewhere; bundling them would deny the self-hoster the choice the architecture already grants and would make the star carry roles that are not custody.
