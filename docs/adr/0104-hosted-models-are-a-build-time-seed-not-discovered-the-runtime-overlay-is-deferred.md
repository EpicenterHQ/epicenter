# 0104. Hosted models are a build-time seed catalog, not a discovered one; a runtime overlay is a named deferral

- **Status:** Superseded
- **Date:** 2026-07-03
- **Superseded by:** [ADR-0618](0618-epicenter-hosts-no-ai-service.md), Epicenter's inference: Epicenter runs no inference or transcription gateway, bills no AI credits, and keeps no local model, and an AI connection survives only as the CLI's bring-your-own-key keychain entry.
- **Relates:** [ADR-0060](0060-an-inference-connection-is-a-base-url-and-an-optional-bearer-key.md) (custom connections discover their models via `/v1/models`; this decides why hosted does not), [ADR-0050](0050-the-inference-contract-is-openai-compatible.md) (the OpenAI-compatible wire and the free-string model id the gateway routes), [ADR-0054](0054-an-inference-backend-is-the-metered-gateway-or-a-custom-server.md) (the metered gateway hosted points at), [ADR-0100](0100-ai-credits-are-product-units-and-the-charge-shape-follows-when-cost-is-known.md) (the credit price a hosted catalog entry carries)

## Context

[ADR-0060](0060-an-inference-connection-is-a-base-url-and-an-optional-bearer-key.md) made custom OpenAI-compatible endpoints discover their models at runtime through `GET /v1/models`, and left hosted models as a curated catalog (`packages/constants/src/ai-providers.ts`) injected per app. A live pass asked the symmetric question: should the hosted gateway also expose `/v1/models` so hosted models are discovered the same way, dropping the hard-coded catalog? The pull is real because the model landscape moves fast and a bundled catalog means shipping every client to sell a new model. The decision matters because it governs where the hosted catalog lives and whether product metadata (label, credits, per-app default) survives.

## Decision

**Hosted models stay a build-time seed catalog, authored and owned by us. Discovery through `/v1/models` is for connections we do not own; hosted is not discovered. A runtime catalog overlay is a named, trigger-gated extension, not built until catalog-change velocity outpaces client-ship cadence.**

- **Discovery is for facts you do not own.** A custom endpoint is someone else's box, so its model list is genuinely unknown until runtime and must be discovered. The hosted catalog is authored by us; fetching it back from our own gateway is re-learning what we shipped. The two lanes look symmetric but are not: a custom model is a bare id (all `/v1/models` carries), while a hosted model is a *product* (label like "Fast"/"Best", a credit price shown before the call, an app default). `/v1/models` cannot carry the product half, so routing hosted through it either loses the metadata or smuggles non-standard fields through a standard-shaped hole.
- **The single source is the typed catalog, not a raw JSON file.** `AI_MODELS` stays a typed `as const` literal so `ServableModel`, `SERVABLE_MODELS`, and the arktype enumeration keep their compile-time narrowing. A `.json` import would widen ids to `string`. When a served artifact is needed, it is that typed catalog *projected* to JSON at a URL, never a hand-edited file that drifts from the types.
- **The catalog is layered as seed / overlay / enrichment.** Layer zero is the bundled seed (`AI_MODELS`, offline, typed, present at first paint). A future runtime *overlay* spreads more entries on top (fetch fails, seed stands, so the picker is never empty). A separate optional *enrichment* layer (models.dev-shaped upstream facts: context window, tool support, modality) decorates both hosted and custom ids for display and never carries our prices.
- **The commercial catalog is a distinct, owned layer from any community catalog.** What we sell and what we charge is a business fact we author; upstream model facts are a community fact we may consume. They never merge into one source. (OpenCode is the same shape: it reads community metadata from models.dev but keeps its own hosted product's pricing on a separate endpoint.)
- **The runtime overlay is deferred with a named trigger.** Build it when the hosted catalog changes faster than clients ship. Because `AI_MODELS` is already the seed, the overlay grafts on later with zero rework: add a producer (a gateway catalog route or a served projection) and a merge, validated by one schema. Until then no overlay code exists.

## Consequences

- **A future reader has a settled answer to "why not discover hosted too?"** without re-running the pass. The hosted gateway does not need `GET /v1/models`, reaffirming [ADR-0060](0060-an-inference-connection-is-a-base-url-and-an-optional-bearer-key.md).
- **Adding a hosted model still ships a client today.** Accepted while the catalog is small and rarely changed; the overlay is the escape hatch when that cost bites, not a thing carried empty now.
- **Two guards are pre-decided for the overlay so it cannot be built carelessly.** The overlay wins on *presence* (new ids appear) but must not silently rewrite *price*: either the seed wins on credits or the served payload is signed, so a bad deploy cannot re-bill a user mid-session. And the gateway serves a public projection (a DTO), never the internal catalog.
- **The type cost of the eventual overlay is already priced.** [ADR-0050](0050-the-inference-contract-is-openai-compatible.md) already made the model id a free string the gateway routes (an unservable id is a runtime error, not a compile error), so overlay-added ids being unbounded strings is consistent, not a regression. The seed keeps its literal union.
- **Nothing in the client changes.** Custom `/v1/models` discovery, the injected hosted transport, and the custom-before-hosted collision tie-break all stand as [ADR-0060](0060-an-inference-connection-is-a-base-url-and-an-optional-bearer-key.md) left them.

### Refinement (2026-07-03): the overlay read should be query-backed

When the overlay is built, prefer a TanStack Query read over a hand-rolled localStorage cache:

- The hosted query uses `AI_MODELS` as `initialData`. Failed or malformed fetches leave the seed visible, so the group never empties. Cross-session persistence is unnecessary unless the seed-to-overlay blink becomes a real UX problem.
- The fetched catalog still goes through the overlay guard above: runtime can add ids, but price changes need an explicit server-authority decision (for example, a signed payload or a server-owned app catalog). Do not smuggle that decision into a client cache.
- The custom lane can use the same query shape later, keyed by each connection's base URL, with `queryFn` = `/v1/models` discovery and `initialData` = the connection's last-discovered ids. That would retire manual refresh state once a query producer exists; until then, the current manual refresh is the smaller fix for stale custom models.
- **Still open at trigger time:** whether the server owns the per-app catalog subset (a registry) or apps keep client-side curation. A global catalog can replace the seed after validation; per-app subsets need the server to know the app-to-models mapping or the client to keep filtering.

## Considered alternatives

- **Expose hosted over the gateway's `/v1/models` and drop the catalog.** Rejected: `/v1/models` carries no label, credit price, or app default, so it deletes the reason the hosted lane exists; and it re-couples the catalog to a boot fetch with an offline failure mode for a fact we already own.
- **Make the seed a raw `.json` file (importable and servable as one artifact).** Rejected as the *source*: JSON imports widen ids to `string` and lose the literal union without a codegen step not worth its weight at this catalog size. The typed const projected to JSON is the same artifact without the type loss.
- **Build the runtime overlay now.** Rejected: no producer exists, so a `mergeCatalog`/schema seam would be structure implying a completeness the product lacks. Deferred with a named trigger, non-breaking to add.
- **Fold the commercial catalog into a community catalog (models.dev-style).** Rejected: our prices and product labels are a business decision, not a community-editable fact; they stay in an owned layer.
