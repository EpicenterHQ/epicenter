# 0155. Epicenter desktop auth is one Bun authority with credential-free windows

- **Status:** Accepted
- **Date:** 2026-07-19
- **Amends:** [ADR-0118](0118-epicenter-is-one-trusted-bun-hosted-spa-origin.md): the refusal is a generic Bun-to-Rust command bridge; one closed auth-native port may reach keychain storage, system-browser launch, and deep-link delivery.
- **Amended by:** [ADR-0230](0230-an-auth-client-always-offers-openwebsocket-and-a-model-that-cannot-sync-denies-permanently.md): the consequence below naming `SyncAuthClient` as the application contract is withdrawn. The contract is `AuthClient`, and the broker projection expresses its inability to sync as a permanent `openWebSocket` denial rather than by satisfying a sync-capable type it could not honor. Credential-free windows and the broker projection are otherwise unchanged.
- **Amended by:** [ADR-0260](0260-the-desktop-host-owns-the-profile-registry-and-active-profile.md) at profile selection and retained profile state. **Superseded by ADR-0262.** One active runtime, credential-free windows, and host-owned auth remain.
- **Amended by:** [ADR-0262](0262-the-desktop-host-owns-one-active-connection-and-no-connection-registry.md) at the selected connection. One active runtime, credential-free windows, and host-owned auth remain.
- **Amended by:** [ADR-0556](0556-outside-a-webview-typescript-runs-only-as-the-epicenter-cli.md) at "one Bun authority": the authority is the `epicenter` CLI, and windows stay credential-free.
- **Relates:** [ADR-0053](0053-the-epicenter-bearer-is-an-audience-scoped-credential.md), [ADR-0071](0071-oauth-is-hosted-only-a-custom-instance-requires-a-token.md), [ADR-0075](0075-self-host-is-a-single-partition-instance-behind-one-operator-supplied-bearer.md), [ADR-0109](0109-hosted-tauri-auth-keeps-app-owned-keyring-edges-until-three-real-callers-earn-sharing.md), [ADR-0149](0149-local-blob-stores-are-canonical-and-remote-replication-is-explicit.md), [ADR-0153](0153-trusted-apps-are-source-built-static-catalog-members.md), [ADR-0154](0154-blob-access-is-address-only.md)

## Context

Epicenter hosts several trusted SPA windows under one Tauri application and
one required Bun process. Constructing a complete OAuth or instance-token
client inside every window gives each window its own refresh, verification,
and in-memory auth state while all of them mutate one persisted credential,
and refresh-token rotation races across independent runtimes. The enforcing
window CSP (`connect-src 'self' ipc: http://ipc.localhost`) also means a
built-in surface window cannot reach the cloud or a self-host origin through
browser fetch, so a window-owned credential cannot even be exercised where it
lives. Derived-catalog app windows separately hold generic native HTTP egress
(ADR-0153); that is transport without identity, and it does not change who
owns credentials.

The host process, by contrast, already owns durable local state (workspaces,
blob bytes) and is the natural owner of outbound deployment traffic: record
sync and blob replication are host responsibilities, not window
responsibilities.

## Decision

Bun owns one desktop auth authority for the lifetime of the Epicenter host.
It owns the selected deployment (hosted OAuth or a self-host URL plus token),
the authoritative auth state, the persisted credential cell, OAuth sign-in
and revocation, refresh and session-verification single-flights, and
credential generation. The selected deployment and principal are immutable
for one Rust+Bun process generation: sign-in, sign-out, and instance
selection persist the next desktop auth cell and relaunch the application.
Token refresh within the same principal stays inside the running authority.

Windows are credential-free projections. Each trusted SPA document is served
with a non-secret identity snapshot, and only to an established browser
session; before the bootstrap exchange the origin serves a session shell.
Account commands (sign-in, sign-out, instance selection) and the profile read
are same-origin broker routes the authority acts on. There is no
authorize/bearer-grant route: no bearer, refresh grant, or instance token
ever enters a WebView JavaScript realm, no window opens an authenticated
socket, and the loopback-only CSP is unchanged. A capability that needs the
deployment (blob replication, record sync) lives in the host and is exposed
to windows as a same-origin operation on host-owned state.

Rust owns the native mechanisms the authority needs, not auth semantics. A
closed, versioned Rust-Bun stdio port (protocol v2) hands Bun one opaque
desktop auth cell at boot, stores the next cell, opens only the validated
hosted authorization URL in the system browser, delivers the exact Epicenter
OAuth callback, and relaunches the application. It cannot execute arbitrary
commands, proxy HTTP, select keyring names, or expose a general Bun-to-Rust
invocation surface. The previous per-window keyring bootstrap and keyring
Tauri commands are deleted.

## Consequences

- Signing in, signing out, or choosing a self-hosted instance restarts
  Epicenter. Every reopened window receives the same immutable boot identity;
  a window's auth state and self-host connection status are serve-time
  projections that go stale only until relaunch.
- Desktop windows have no deployment identity. Built-in surface window code
  that fetches the deployment directly keeps failing under the unchanged CSP
  exactly as it did before. A derived-catalog app window can reach arbitrary
  origins through the ADR-0153 native HTTP slice, but it carries no bearer,
  refresh grant, or instance token to present there. Making an
  Epicenter-deployment feature work on desktop means moving its network
  operation into the host, never granting a window a credential.
- The desktop persists one active credential, not a wallet of dormant stars.
  Choosing a self-hosted instance replaces the hosted refresh grant; returning
  to hosted starts signed out.
- `SyncAuthClient` stays the application contract. Browser builds keep their
  per-origin client; Epicenter desktop builds select the broker projection
  adapter at build time.
- Build-time trust is load-bearing: if Epicenter later runs unreviewed code,
  the same-origin broker routes stop being an adequate boundary.

## Considered alternatives

- **Window-local transports over broker bearer grants.** Each window fetches
  a transient bearer from the authority and performs its own deployment fetch
  and WebSocket, with the CSP widened to the active deployment origin.
  Rejected: it puts a live bearer in every trusted JavaScript realm, makes
  the CSP identity-dependent, and duplicates 401-retry semantics per window,
  when the host already owns every deployment-facing capability.
- **Proxy every request and WebSocket through Bun.** Rejected because it
  turns auth into a generic transport product and changes browser semantics.
- **Keep one complete auth client per window over shared keychain storage.**
  Rejected because refresh-token rotation and verification state race across
  independent runtimes, and the CSP blocks the client's own traffic.
- **Move the auth state machine to Rust.** Rejected because it duplicates the
  TypeScript OAuth, instance-token, and error semantics. Rust remains the
  narrow native mechanism owner.
- **Change identity in the running desktop and reload every window.**
  Rejected because it requires a mutable boot epoch, stale-window rejection,
  and distributed transition blockers. A process restart is the identity
  boundary.
