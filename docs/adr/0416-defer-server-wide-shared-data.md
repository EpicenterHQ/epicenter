# 0416. Defer server-wide Shared data

- **Status:** Proposed
- **Date:** 2026-09-19
- **Amends:** [ADR-0412](0412-app-data-addresses-name-scopes-not-libraries.md) at supported data scopes: device and personal remain; Shared is removed.

## Context

Shared added an optional store, auth capability flags, native boot fields, UI
selection, and server admission policy without a current product need. Most apps
never displayed it even though opening an App could create and synchronize it.

## Decision

This removal leaves device data and the captured Account's personal data.
There is no legacy server-wide Shared store, selector, auth flag, deployment
option, or server admission switch. Both hosted and self-hosted servers accept only personal data
scope requests. Existing personal routes and storage identities remain unchanged.

Configuration stays in source and each build chooses one server. Auth server
identity is `{ baseURL, authorityId }`; it carries no feature flags.

Removing Shared does not erase or migrate its persisted data. Existing Shared
data is inaccessible through the application. An obsolete Whispering display
preference falls back to Personal when signed in, without moving recordings.

## Deferred direction

The future target is an explicitly opened store owned by a named space, not
one store shared by everyone admitted to a server. A space has members and can
own stores from several applications. Its durable address uses `shared/<id>`.

Membership, admission, revocation, offline edits, and refusal handling require
a separate design before this feature ships. Removing the old implementation
does not prebuild the new one or migrate historical Shared data into a space.
Local and Personal work does not depend on implementing spaces.

## Consequences

Apps and auth no longer transport or interpret Shared availability. Server data
addressing has one authenticated scope. Shared-specific tests are removed;
personal owner isolation and rejection of unsupported scopes remain tested.

Self-hosted operators must update clients with the server. Older clients may
request Shared during startup and fail to open against a server that refuses it.

## Considered alternatives

- Keep Shared disabled behind a flag: retains the implementation and its tests
  for a feature we do not currently support.
- Always attempt Shared and let the server refuse: requires refusal and offline
  behavior before any app needs the feature.
