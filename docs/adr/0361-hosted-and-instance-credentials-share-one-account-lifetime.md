# 0361. Hosted and self-hosted sessions share one Account lifetime

- **Status:** Proposed
- **Date:** 2026-09-08

## Context

Cloud and self-hosted sign-in both acquire a session bearer, verify its principal
through `/api/session`, persist it, and publish an Account. Their sign-in pages
and server policy differ; the client's ownership and cancellation rules do not.

## Decision

`createSessionAuth` owns verification, ordered persistence, cancellation, and
Account retirement for both deployments. A launcher acquires the credential
inside that cancellation boundary. UI cannot assert a verified principal or
install a stale result after cancellation.

Trusted composition supplies one server origin and authority identity. Browser
apps use one redirect client; desktop Bun owns the same session lifecycle behind
its native handoff. WebViews receive only the boot identity and brokered Account
access. Cloud account-management capability belongs to composition, not to a
principal-name convention.

A restored identity can open local data offline. Its credential must verify
before resource access. Refusal preserves the Account in `reauth-required`;
verified replacement by another principal retires it. Same-person repair keeps
the uninterrupted Account. Retirement cancels requests and sockets and cannot
borrow a later credential.

Current self-hosted deployments issue named-user sessions after passkey sign-in.
Historical static operator tokens have no application client or entry form.
Old `instance` data remains at its historical address and is never attached to
a named-user session. No implicit data migration accompanies sign-in.

## Consequences

One implementation owns both session lifetimes. Browser credentials are scoped
to their issuer origin; desktop validates the saved method and origin against its
configured server. Neither unscoped old browser credentials nor foreign-server
native credentials can publish identity or authorize traffic.

Shared authentication does not establish feature parity. Self-hosted Worker
sync and Cloud billing remain deployment concerns. The Bun self-host entry
still has no store synchronization backend.

## Considered alternatives

- Retain static-token client compatibility: keeps an authentication mode the
  current self-host entries no longer accept.
- UI-owned credential installation: separates acquisition from cancellation and
  permits a late result to reconnect the client.
- Independent Cloud and self-host session owners: duplicates cancellation,
  persistence, offline identity, and transport retirement without a different
  application requirement.

## Verification

Account lifetime tests cover cancellation, ordered writes, remote revocation,
offline identity, same-person repair, and retired transport. Browser tests prove
origin-scoped credential restoration. Desktop tests cover native write rollback,
close barriers, window identity, relaunch failure, and foreign credential refusal.

The AppBoot browser fixture holds both a producer and a store commit through
sign-out. The self-host browser fixture exercises actual enrollment, passkey
sign-in, callback completion, offline restoration, recovery, and removal against
Bun or a local Worker. Packaged native callback and relaunch verification remain
separate from these local tests.
