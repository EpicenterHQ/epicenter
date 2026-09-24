# 0353. A data session keeps one account for its entire lifetime

- **Status:** Proposed
- **Date:** 2026-09-07
- **Amends:** [ADR-0339](0339-an-application-creates-one-epicenter-and-an-account-is-what-adds-a-store.md) at account selection: the inert constructor takes the app id and definition; `open(account)` captures the account per session.
- **Amends:** [ADR-0350](0350-a-data-session-is-a-value-the-tree-owns-and-sync-runs-for-the-life-of-the-store.md) at the session key and account lifetime: key on the Account object, preserve it through renewal within one authority, and permanently retire its transport on sign-out or replacement. The session owns sync and closes normally.
- **Amends:** [ADR-0230](0230-an-auth-client-always-offers-openwebsocket-and-a-model-that-cannot-sync-denies-permanently.md) at its universal socket requirement: Account owns data transport; AuthClient selects accounts; cookie-only account UI promises neither an Account nor a socket stub. Runtime transport refusals remain typed.
- **Relates:** [ADR-0226](0226-a-host-serves-bundles-and-brokers-credentials-it-owns-no-application-data.md): authenticated byte forwarding preserves app-owned stores and synchronization.

## Context

Apps own their local storage and synchronization in both browser and desktop
builds. Desktop credentials belong to the Bun host, which carries authenticated
HTTP and live sync traffic without exposing credentials to the WebView.

The previous account snapshot fixed the local principal and server address but
delegated transport to a mutable auth client. Delayed authorization could use a
later account's credential. The existing keyed app lifecycle usually contained
that weakness by replacing the session; the interface did not enforce it.
The desktop transport was a separate demonstrated omission: its window had no
authenticated HTTP or sync path through the host.

## Decision

**A data session keeps one person and one server until it closes; signing out
permanently ends that account's network access.**

Auth publishes a stable Account in its signed-in and reauth-required states.
Within a running auth authority, refresh, disconnection, and uninterrupted
reauthentication as the same person preserve that object. Browser navigation
and desktop host relaunch create a new authority and application session.
Sign-out or account replacement retires it. Signing back in creates a new object even when the principal and server are unchanged.

The credential authority owns the account lifetime independently of token
rotation. Authorization checks that lifetime after asynchronous work; transports
check it again before dispatch. Retirement cancels pending requests and response
streams and closes sockets. It cannot retract a server operation already applied.

Apps construct an inert handle from their app id and definition, then call
`open(account)`. Their boot nodes key session components on the Account object.
Session-owned inference, transcription, and blob requests use that same Account.
Retries and erasure never reread the controller's current account selection.

The desktop host captures its boot Account. Its HTTP and socket relays always
use that value, including while sign-in persists a replacement before relaunch.
The host forwards protocol bytes and does not acquire a replica or reconnect
independently. A window that closes its data session closes its sync connection.

The dashboard now holds an independent signed session and uses Account under
the same contract, as proposed in
[ADR-0354](0354-hosted-applications-authenticate-with-better-auth-session-bearers.md).
Its keyed child owns its captured management/billing clients and query cache.
The former cookie-only client and AuthControls exception are removed. Browser
cookies remain part of hosted sign-in and provider/passkey ceremonies, not
dashboard resource selection.

## Consequences

An old operation cannot adopt a successor account's credential, even if UI
teardown is delayed or a desktop relaunch fails. Ordinary refresh and offline
editing do not remount the data session. Cached data remains on the device;
sign-out removes access through the app's boot gate, and explicit local removal
is a separate operation.

Desktop HTTP forwarding fixes the destination, strips credential and transport
headers, and streams responses. Sync uses a private local readiness/refusal
handshake followed by a bounded byte relay. The sync engine remains app-owned.

Current builds still select one server. This change fixes the server on an
Account; it does not add a server picker or migrate IndexedDB addresses to
include a server segment.

## Considered alternatives

- Keep mutable controller transport and rely on keyed teardown. That makes
  account isolation depend on every caller's timing.
- Bind only the principal string. Signing out and back into the same principal
  would revive old work.
- Bind the access token. Routine refresh would retire useful local sessions.
- Move replica ownership or background sync to the desktop host. That changes
  the agreed data ownership model instead of supplying its missing transport.
- Give every auth client a socket method that can refuse permanently. The
  dashboard has no data session and needs no such promise.
