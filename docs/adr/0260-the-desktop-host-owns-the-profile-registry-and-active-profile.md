# 0260. The desktop host owns the profile registry and active profile

- **Status:** Superseded
- **Date:** 2026-08-21
- **Superseded by:** [ADR-0262](0262-the-desktop-host-owns-one-active-connection-and-no-connection-registry.md)
- **Amends:** [ADR-0155](0155-epicenter-desktop-auth-is-one-credential-free-window-bun-authority.md) at desktop profile selection and retained profile state. The one active runtime, credential-free windows, and host-owned auth authority remain.
- **Amends:** ADR-0109 at the decision to defer multi-account storage. Profile-correct storage is now required; remembered credentials remain optional product work.
- **Relates:** [ADR-0226](0226-a-host-serves-bundles-and-brokers-credentials-it-owns-no-application-data.md), [ADR-0227](0227-one-runtime-a-desktop-spa-in-a-webview-over-a-client-owned-store.md), [ADR-0232](0232-a-page-lifetime-is-one-auth-generation-and-a-permanently-denied-sync-stops-for-good.md), [ADR-0259](0259-a-desktop-profile-is-addressed-by-a-server-url-and-principal-pair.md)
- **Unbuilt:** The multi-profile host registry, profile-qualified app openers, and profile selection UI are not implemented yet.

## Context

The native Epicenter desktop host is the common parent of the first-party app
WebViews. It already owns the shared auth authority and must prevent each
window from maintaining an independent refresh loop or self-host credential.
It must also select the local data namespace before the WebViews boot, because
an application store cannot safely change its principal or server while open.

The host must own this connection state without becoming an application data
store. Application documents, projections, replicas, and sync engines remain
owned by their applications under ADR-0226 and ADR-0227.

## Decision

**The native desktop host owns a profile registry and exactly one active profile
per running desktop process.** A profile registry entry contains profile
metadata, including the canonical base URL and verified principal id from
[ADR-0259](0259-a-desktop-profile-is-addressed-by-a-server-url-and-principal-pair.md).
The active profile pointer selects which profile every WebView opens for that
process.

The host persists profile metadata separately from credential material. The
native secure credential store holds the hosted grant or self-host bearer; the
WebViews and app-local stores never receive that raw material. The host
exposes only the current profile snapshot and authenticated capabilities such
as `auth.fetch` and `auth.openWebSocket`.

Profile selection happens before app stores open. Selecting another profile,
creating a profile, signing in as another principal, or changing the server
causes the host to close and relaunch its WebViews. No app can override the
active profile, and no process has two active profiles at once.

The data model supports multiple profile records even when the first product
surface offers only one active profile and ordinary sign-out/sign-in. Retaining
multiple credentials for instant switching is optional product behavior, not a
requirement of the storage model. A profile without a credential remains a
valid offline data namespace.

Signing out removes the active profile's credential and network authority but
preserves its profile metadata and application data. Deleting local profile
data is a separate explicit host action.

## Consequences

```text
Epicenter desktop host
├── activeProfileId
├── profiles
│   ├── profile_01 = (Cloud URL, user_123)
│   └── profile_02 = (home URL, instance)
├── native secure credentials
└── WebViews for activeProfileId only
    ├── Honeycrisp store: (honeycrisp, activeProfileId)
    └── Whispering store: (whispering, activeProfileId)
```

- `activeProfileId` is a host pointer, not a second server identity. It is the
  normal state needed to select one namespace from several retained ones.
- The host can ship a single-profile UI first. The profile-qualified storage
  contract prevents a later account switch from requiring every app to
  redesign its database.
- App-specific sync policy remains app-owned. App-specific server or principal
  selection is refused.
- A profile switch reloads all apps together, preserving the one-auth-generation
  rule in ADR-0232.
- The host stores operational profile metadata, not application rows. This
  does not weaken the host/data boundary in ADR-0226.
- A compromised WebView cannot read a raw long-lived credential, but IndexedDB
  remains persistence and namespacing, not encryption. Device security and the
  host capability boundary remain necessary.

## Considered alternatives

- **Let every app own auth and profile selection.** Rejected. It multiplies
  credentials, refresh races, sign-out behavior, and possible data mixing.
- **Keep one global active URL with no profile namespace.** Rejected. It makes
  switching accounts or servers a destructive rebind and forces every app to
  discover the old data boundary independently.
- **Proxy every app's application data through the host.** Rejected by
  ADR-0226. Credential brokering is host-owned; application data and sync are
  app-owned.
- **Retain multiple live profiles in one process.** Rejected. It would require
  each WebView, sync engine, and host capability to carry a second active
  identity. Use one active profile and relaunch instead.
