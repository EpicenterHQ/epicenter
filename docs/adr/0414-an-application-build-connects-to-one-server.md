# 0414. An application build connects to one server

- **Status:** Proposed
- **Date:** 2026-09-19

## Context

Runtime server selection required a saved destination, nullable auth startup,
connection forms, selection recovery, and replacement operations in both browser
apps and the desktop host. The product does not need people to change servers
inside an installed app. Self-hosters can configure and rebuild their deployment.

## Decision

Each application build connects to one configured server. Changing that server
requires rebuilding and redeploying. Official builds use Epicenter Cloud.
Browser builds take a self-hosted origin from `VITE_EPICENTER_SERVER`. The native
host takes `EPICENTER_SERVER_ORIGIN` at compile time. Debug Cloud builds retain
the loopback development API override.

An `AuthServer` descriptor supplies only the origin and authority identity.
Account-management presentation is configured separately. Browser apps construct
the auth client directly. Rust passes the desktop descriptor to Bun in its
private boot message and validates native sign-in URLs against that same origin.
WebViews receive brokered Account access, never server credentials.

Saved state cannot choose a server. Browser credentials are origin-scoped.
Desktop restores its saved credential only when its origin matches this build
and its credential format is supported. An unreadable or mismatched credential
starts signed out, with sign-in
available. Startup neither sends that credential elsewhere nor erases local
data. Explicit sign-in may replace it.

Preserve Cloud's `epicenter-api` authority and the existing origin-derived
self-host authority bytes. Historical static-token `instance` data remains
untouched and is never assigned to a named person. Account changes still close
application work before authentication changes and navigation or relaunch.

## Consequences

Server forms, persisted selection, switching endpoints, invalid-selection
recovery, and historical static-token client constructors disappear. A stock
Cloud build cannot connect to a self-hosted server. Operators must build and
serve an app configured for their server and register its callbacks.

Sign-in cancellation, credential rollback, offline identity, and application
closure remain necessary. Removing server choice does not remove those lifetimes.

## Considered alternatives

- Keep runtime selection only on desktop: preserves a second startup model and
  its credential transition machinery for a feature the product no longer needs.
- Read a server choice from local storage: lets saved preferences override the
  build and reintroduces invalid-selection recovery.
- Let Bun and Rust choose independently: permits a configured issuer whose
  sign-in URL the native opener refuses.
