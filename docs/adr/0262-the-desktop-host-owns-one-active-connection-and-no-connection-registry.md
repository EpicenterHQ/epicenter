# 0262. The desktop host owns one active connection and no connection registry

- **Status:** Accepted
- **Date:** 2026-08-22
- **Amended by:** [ADR-0336](0336-an-authority-mints-every-generation-so-every-store-has-an-account.md) at half of one clause. "Sign-out preserves local device and account data" keeps its account half; there is no device data left for it to preserve. Its one-connection rule and its refusal of a registry stand.
- **Amended by:** [ADR-0325](0325-a-database-is-bound-to-one-authority-and-re-homing-is-export-and-import.md) at one clause: "selecting a different server replaces it" is withdrawn, and the surfaces that performed it are deleted. Choosing a server becomes installing a build.
- **Amended by:** [ADR-0326](0326-the-deployment-names-the-authority-and-a-person-never-types-one.md) at what the host holds: one connection per authority named by an installed bundle, derived from what is installed rather than stored. This record's refusal of a registry, of generated profile ids, and of a credential wallet stands, and is honoured more literally: nothing is remembered.
- **Restated by:** [ADR-0263](0263-a-connection-is-one-server-at-a-time-and-a-replica-is-derived-from-it.md) as the reader-facing connection and switching contract
- **Supersedes:** [ADR-0260](0260-the-desktop-host-owns-the-profile-registry-and-active-profile.md)
- **Amends:** [ADR-0155](0155-epicenter-desktop-auth-is-one-credential-free-window-bun-authority.md) at the selected deployment's identity: the host owns one active connection, not a registry of profiles.
- **Relates:** ADR-0109, [ADR-0226](0226-a-host-serves-bundles-and-brokers-credentials-it-owns-no-application-data.md), [ADR-0227](0227-one-runtime-a-desktop-spa-in-a-webview-over-a-client-owned-store.md), [ADR-0232](0232-a-page-lifetime-is-one-auth-generation-and-a-permanently-denied-sync-stops-for-good.md), [ADR-0261](0261-a-local-account-replica-is-addressed-by-its-application-server-url-and-verified-principal.md)
- **Implemented in part:** The host and WebView now share one connection
  snapshot. A future connection-selection UI remains host-owned and still
  reloads the next auth generation.

## Context

The desktop host is already the single owner of credentials and the parent of
the trusted app windows. It must choose the server connection before apps open
their stores, but it does not need a second identity layer to do that.

The superseded decision introduced a profile registry, generated profile ids,
and an active-profile pointer before the product had a requirement for saved
connections or simultaneous accounts. The derived address in ADR-0261 gives
apps correct separation without any of that state.

## Decision

**The desktop host owns one selected server URL and at most one active
connection per auth generation.** An active connection is that server plus the
principal it verified. The host holds the credential for the selected server,
when one exists. The native secure store holds credential material; WebViews
receive only a non-secret connection snapshot and brokered capabilities. A
signed-out host may retain a selected server URL, but it has no active account
connection until that server verifies a principal.

Every app opens the local copy for the connection it receives. An app cannot
choose another server, principal, or credential independently. The host owns
the connection boundary; the app owns its local data and its sync lifecycle.
The host owns no application rows, replicas, or projections.

Changing the server, signing in, signing out, or changing the principal starts
the next auth generation. The host closes or relaunches its WebViews so every
app begins with one coherent connection state and one auth generation.

The host may persist the one current connection configuration needed to boot
the next generation. It stores at most one credential: selecting a different
server replaces it, and signing out clears it. It does not maintain a
saved-connection registry, generated profile ids, multiple live connections,
or a wallet of remembered credentials. Account switching can be added later as
host-owned selection of another derived connection without changing any app's
storage address.

## Consequences

- Login happens once at the host boundary, and trusted apps use the same
  active connection.
- A WebView never receives a raw OAuth grant, refresh token, or self-host
  bearer.
- All apps switch together. No app can accidentally sync against a second
  server while its local store remains open.
- Sign-out preserves local device and account data; deleting local data is a
  separate explicit action.
- The first product surface can expose only one current connection without
  making the storage model single-account or single-server.
- A future connection switcher is a host UI concern, not an app data-model
  change.

## Considered alternatives

- **Let every app select its own server and credentials.** Rejected because it
  duplicates login state and permits apps to open the wrong local copy.
- **Create a profile registry now.** Rejected because a registry adds no
  capability required by the current one-active-connection runtime; the
  connection address is already derived.
- **Keep multiple live connections in one process.** Rejected. It would force
  every WebView, sync engine, and host capability to carry another active
  identity. A switch is a new auth generation.
- **Make the host own application data.** Rejected by ADR-0226. Credential
  brokering and app-data ownership remain separate boundaries.
