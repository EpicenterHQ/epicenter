# 0416. Defer server-wide Shared data

- **Status:** Proposed
- **Date:** 2026-09-19
- **Amends:** [ADR-0412](0412-app-data-addresses-name-scopes-not-libraries.md) at supported data scopes: device and personal remain; Shared is removed.

## Context

Shared added an optional store, auth capability flags, native boot fields, UI
selection, and server admission policy without a current product need. Most apps
never displayed it even though opening an App could create and synchronize it.

## Decision

An App opens device data and, when signed in, the captured Account's personal
data. There is no Shared store, selector, auth flag, deployment option, or server
admission switch. Both hosted and self-hosted servers accept only personal data
scope requests. Existing personal routes and storage identities remain unchanged.

Configuration stays in source and each build chooses one server. Auth server
identity is `{ baseURL, authorityId }`; it carries no feature flags.

Removing Shared does not erase or migrate its persisted data. Existing Shared
data is inaccessible through the application. An obsolete Whispering display
preference falls back to Personal when signed in, without moving recordings.

## Deferred direction

If people need it, we can implement one server-wide Shared store per app at a
`/shared` scope beside `/personal`. Every admitted person on that server would
access the same app store. This is not team or organization sharing on a
multi-user Cloud service.

A future implementation would make apps explicitly request Shared and let the
server grant or refuse it. Operators, including Epicenter, would activate it
deliberately in source. Admission, offline edits, and refusal handling must be
defined when there is a real use case. No dormant feature flag or implementation
is retained now.

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
