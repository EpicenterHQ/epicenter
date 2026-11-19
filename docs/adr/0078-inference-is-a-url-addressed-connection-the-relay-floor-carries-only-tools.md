# 0078. Inference is a URL-addressed connection; the relay floor carries only tools

- **Status:** Accepted (historical relay-floor tool carrier superseded by ADR-0079/ADR-0086; inference remains URL-addressed)
- **Date:** 2026-06-29
- **Relates:** [ADR-0073](0073-tools-speak-mcp-natively-epicenter-owns-only-the-transport-mcp-lacks.md) (the relay floor is the one cross-device transport, carrying MCP tool routes), [ADR-0060](0060-an-inference-connection-is-a-base-url-and-an-optional-bearer-key.md) (a connection is a base URL and an optional bearer key), [ADR-0054](0054-an-inference-backend-is-the-metered-gateway-or-a-custom-server.md) (an inference backend is the metered gateway or a custom OpenAI-compatible server), ADR-0050 (the model boundary is OpenAI-compatible), [ADR-0068](0068-privacy-is-a-deployment-not-a-product-feature.md) (privacy is which relay you run), ADR-0075 (the operator bearer)

## Context

ADR-0073 generalized the per-user relay into a floor that routes typed channels to a person's devices, carrying MCP tool routes to immovable home data (Local Books). A second channel vocabulary was then built and tested on this branch: a peer SERVICE route that tunnels an arbitrary local HTTP service (a whisper box, an own-box inference port) to a NAT'd peer through a localhost forward, so a consumer reaches it as an ordinary `Connection { baseUrl }`. That raised the keystone question: is a relay service route a legitimate second way to reach movable compute (inference), beside the OpenAI-compatible inference gateway that already exists (ADR-0054, `mountInferenceApp` at `/v1`)?

## Decision

**Inference is a URL-addressed `Connection { baseUrl, apiKey? }` (ADR-0060), reached by the existing `transcribe()` / `complete()`; the relay floor carries MCP tool routes and only tool routes.** Delete the peer service channel.

The relay brokers access to your resources by reachability, decided by where a resource can be sited, not by wire format:

- **It proxies movable compute it can reach by URL.** Inference is movable, so you always site it for URL-reachability: a local endpoint (this device's Ollama or LM Studio port, the desktop app's native engine) reached directly with no relay, or the inference gateway (`/v1`, ADR-0054) when the client is remote from the model. The gateway is an auth and billing guard: it injects the upstream credential server-side so the model endpoint is never client-facing, and the bearer is the only way in (cloud = session bearer plus Autumn; self-host = the operator bearer, ADR-0075). Its upstream is a localhost OSS box or a hosted GPU endpoint, both just a `PROVIDER_UPSTREAM` base URL, so shipping a hosted model is a provider-table row, not a new handler.
- **It tunnels immovable data it cannot reach by URL.** Home Local Books is kept home by local-first design (NAT'd, URL-less), so the floor genuinely earns its keep tunnelling its MCP tool routes. Tools cannot collapse into the gateway: that would require exposing home data by URL, defeating local-first.

Because compute is movable and always uses the gateway, the peer service channel (tunnelling compute to a NAT'd peer) is a dominated second way to reach compute, so it is deleted. The floor carries tools, not services.

## Consequences

- One channel vocabulary on the floor: MCP tool routes. `Route` collapses its union to a single `SpawnRoute` (the `kind: 'spawn'` discriminant stays as the named seam for a future kind), `openRouteTarget` is a direct call, and discovery carries one bucket of route names (`exposedRoutes`), not two.
- A built, tested, unreleased feature is deleted on purpose: the `createServiceForward` consumer primitive, the `ServiceRoute` variant and its `openServiceTarget`, the `--relay-service` / `--relay-forward` CLI flags, and the second discovery list (`exposedServices`) across presence, the account-room opener, collaboration, and the server connection attachment.
- Adding a hosted OSS model is additive configuration (a provider base URL behind the gateway), never a new relay route or a new transport. Inference and tools stay two honest shapes (a URL-addressed connection and a tunnelled MCP route) reached two honest ways, instead of one fake-symmetric "everything is a relay route."
- The floor's keep is narrowed and therefore honest: it exists for what cannot be reached by URL. The day a genuinely immovable, non-tool service appears (one that cannot be a URL connection and is not MCP), reintroducing a second `Route.kind` is the named extension point; until a live producer exists, the floor refuses it.

Update 2026-07-02: ADR-0079/ADR-0086 deleted the relay-floor capability layer after no live consumer remained. The inference decision still stands: inference is URL-addressed and reached through a direct endpoint or gateway. The historical claim that the floor carries MCP tool routes no longer describes live code.

## Considered alternatives

- **Keep the peer service channel as a second way to reach inference.** Rejected as dominated. Compute is movable, so it is always sited for URL-reachability and always uses the gateway; a NAT-tunnel to reach it is a redundant path with its own forward, discovery vocabulary, and failure modes.
- **Fold MCP tool routes into the inference gateway so the floor disappears entirely.** Rejected: that requires exposing home data by URL, which defeats local-first. The gateway proxies what is URL-reachable; the floor tunnels what is not. They are not one mechanism.
- **Make the relay floor carry both MCP and HTTP services as two vocabularies on one transport.** Rejected as fake symmetry. An HTTP service that can be sited for URL-reachability is a connection, not a tunnelled route; the only services that genuinely cannot are out of scope until one exists.
