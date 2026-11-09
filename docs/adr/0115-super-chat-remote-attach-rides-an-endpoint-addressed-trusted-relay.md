# 0115. Super Chat remote attach rides an endpoint-addressed trusted relay

- **Status:** Superseded by [ADR-0236](0236-remote-super-chat-attach-is-deferred-until-the-complete-product-exists.md)
- **Date:** 2026-07-07
- **Superseded by:** [ADR-0236](0236-remote-super-chat-attach-is-deferred-until-the-complete-product-exists.md)
- **Relates:** [ADR-0080](0080-the-super-app-is-a-desktop-host-cross-device-is-remote-access-to-the-session-not-a-per-app-capability-plane.md) (Super Chat is a desktop host and remote devices attach to the session, not to per-app endpoints), [ADR-0079](0079-cross-device-is-two-planes-epicenter-syncs-the-crdt-the-box-is-reached-directly.md) (remote attach is the live plane, distinct from durable sync), [ADR-0086](0086-no-live-consumer-for-network-reachable-capability-reach-opensidian-is-superseded-not-migrated.md) (network-reachable capability reach stays refused; a session channel is not a capability route), [ADR-0073](0073-tools-speak-mcp-natively-epicenter-owns-only-the-transport-mcp-lacks.md) (the relay-floor organs stay deleted), [ADR-0113](0113-super-chat-session-commands-are-host-owned-transports-only-frame-them.md) (Super Chat session commands are host-owned; the relay forwards their bytes), [ADR-0004](0004-trust-the-relay-reject-zero-knowledge.md) and [trust-model](../trust-model.md) (hosted Epicenter is trusted infrastructure, not zero-knowledge infrastructure), [ADR-0068](0068-privacy-is-a-deployment-not-a-product-feature.md) (privacy is the deployment: self-host makes the operator the user), [ADR-0075](0075-self-host-is-a-single-partition-instance-behind-one-operator-supplied-bearer.md) (a self-hosted instance is reached by URL and token)

## Context

Super Chat is a desktop host that owns local tools and local source data; a phone or a second browser is a thin client that attaches to the one running session (ADR-0080, ADR-0113). The product pull is that a signed-in phone reaches that session with no tailnet and no per-app remote capability surface. The desktop is NAT'd, so reaching it needs a publicly addressed rendezvous both sides dial out to (ADR-0079), and the rendezvous the phone already trusts is Epicenter itself.

The first accepted form of this ADR required a content-blind relay: endpoints sealed frames above the relay, Cloud could not read the live session, and a pairing secret defended against operator MITM. The greenfield review reopened that promise. It was internally inconsistent with ADR-0004's trusted-hosted-sync stance unless the whole Super Chat data plane, including transcript sync, became end-to-end encrypted. The product stance is now simpler: **privacy equals self-host**. Hosted Cloud is trusted infrastructure for live attach frames. Users who do not want Epicenter-operated infrastructure to see Super Chat data run the self-hosted instance.

## Decision

Remote Super Chat attach rides an **AttachRelay**: Epicenter forwards live Super Chat session bytes between two authenticated endpoints of one principal, a signed-in client endpoint and a desktop Super Chat host endpoint.

1. **The relay is endpoint-addressed, never route-addressed.** It routes by `principalId`, `hostId`, `deviceId`, and `attachId`. The routing unit is a pair of endpoints under one principal, not a named route. There is no route name, no route registry, no `exposedRoutes` presence, no client auto-mount, no MCP carried as a platform surface over the relay, no CLI `tools` or `call` surface, and no per-app endpoint directory. Those are the relay-floor organs deleted in PR #2277, and endpoint addressing is what keeps them from having anywhere to live: with no route namespace, there is nothing for a capability registry to populate. The AttachRelay is not the relay floor.

2. **The relay is trusted transport, not an encryption boundary.** It stores no session frames and does not own Super Chat command semantics, but it may observe live frame payloads while forwarding them. The product promise is not zero-knowledge and not content-blindness. The promise is authenticated transport plus deployment choice: hosted Cloud is trusted, and self-host is the privacy answer.

3. **Attach authorization belongs to the deployment's identity layer.** On Cloud, a signed-in OAuth bearer resolving to principal P authorizes attach to P's hosts. No Cloud device-grant store, pairing ceremony, approval screen, QR, PSK, account device-key table, or safety-number UX is required for attach authorization. On self-host, the operator token administers revocable per-device grants because ADR-0075 gives the instance no account/session substrate; a valid grant resolves to the literal `instance` principal.

4. **The product surface is `attachToSuperChatHost(hostId)`, and it is the only consumer.** The byte-forwarding primitive is generic only in the narrow sense of clause 1: it forwards bytes between two endpoints. It is not exported from `packages/workspace` as a framework verb, and it is used only by `packages/server` and `apps/epicenter`. A second consumer requires a new ADR naming a real, live consumer, the same bar ADR-0086 set.

5. **Live attach and transcript sync remain separate planes.** The relay needs both ends online and stores no frames. Reading the finished transcript while the desktop is offline is a sync-plane property: the phone reads a durable replica of the `conversations` table, not the live channel. Because privacy equals self-host, transcript network sync does not need a special Super Chat E2E exception before it can use the normal trusted sync substrate.

6. **Transport posture.** The AttachRelay is a WebSocket channel on the per-user rendezvous each device already dials out to, because a Durable Object is a WebSocket router and the cloud cannot be a UDP peer (the reason ADR-0073 deleted iroh). Tailscale stays a developer proof for reaching a loopback host, never the product transport. An iroh direct path stays a deferred optimization behind a measured trigger, never the product's spine.

## Consequences

- One sentence explains it: Epicenter forwards live Super Chat bytes between two of your own authenticated devices, addressed by endpoint, never by route.
- "Phone just works after Epicenter sign-in" holds on Cloud without a Super Chat pairing ceremony. Self-host keeps URL + token + per-device grants because it has no account substrate.
- The relay-floor organs stay deleted: the route table, the MCP gateway catalog, `exposedRoutes` presence, the channel router's route addressing, and the CLI `tools`, `call`, and `--relay-expose` verbs. PR #2277's presence-schema guard that rejects route-shaped and action-shaped fields stays in force, and the AttachRelay directory must pass it.
- The single per-launch shared Super Chat token is replaced by per-device grants on self-host attach. ADR-0113 is untouched: the transport still only frames the host-owned commands, and now the transport is the AttachRelay.
- The former sealing layer, PSK pairing artifact, anti-MITM promise, and Cloud content-blind prerequisite are deleted. There is no half-crypto mode: either run trusted hosted Cloud or self-host for privacy.
<!-- doc-path-check: ignore-next-line -->
- The source plane and desktop-offline behavior add no relay surface. A desktop-local read-only source is one host-owned `query` verb the agent loop composes (`apps/epicenter/src/local-source-catalog.ts`, an injected reader so a fixture stands in for Messages.app); a remote client only sends session commands and the tool result rides back inside the live session. The source is never a relay-reachable endpoint, no source row enters any workspace table, and no route/capability/action/tool field enters the relay wire or the host directory.
- This forecloses a second product consumer and a route-addressed capability plane, but no longer forecloses the hosted operator from observing live session payloads.

## Considered alternatives

- **A content-blind hosted relay with mandatory sealing.** Rejected by amendment. It only earns its keep if the whole Super Chat data plane, including transcript sync, becomes E2E. That is not the chosen product stance; privacy equals self-host.
- **A Super Chat-only relay that routes Super Chat session frames.** Rejected. "Super Chat only" describes the product surface, not the mechanism. The mechanism is endpoint-addressed byte forwarding, and the narrowness lives in the product surface (clause 4), which is where this decision puts it.
- **A generic device message relay with Super Chat as one consumer.** Refused. A general routing product surface regrows a route namespace, presence-advertised routes, and per-app endpoints, which is the relay floor ADR-0086 retired. Genericity is confined to the byte-forwarding mechanism and is never exposed as a routing product.
- **Iroh as the product transport.** Deferred: it needs a mobile SDK and Epicenter-operated production relays, its browser story is relay-only, and its direct path relays anyway for a cellular phone reaching a home NAT. It returns only behind a measured trigger.
- **Tailscale as the product transport.** Rejected: bring-your-own-overlay is a developer proof, and a browser off the tailnet needs Funnel (beta, throttled, admin-gated). It proves the shape; it is not the product.
