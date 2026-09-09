# 0382. Session composition selects issuer identity and management capabilities

- **Status:** Proposed
- **Date:** 2026-09-09

## Context

`createSessionAuth` assigned every session the `epicenter-api` authority and a
Cloud dashboard link. That made the generic session lifetime unsafe to compose
for another server: matching user IDs would select the same local authority.
Callback support also inherited a Cloud-specific client type.

## Decision

The composition that selects a session issuer supplies its stable `authorityId`
to `createSessionAuth`. The constructor has no default authority. Cloud browser
and desktop compositions supply the existing `epicenter-api` bytes and attach
`createAccountManagementUrl` themselves. A self-hosted composition must supply
its own installation identity and only capabilities its server implements.

`SessionAuthClient` describes sign-in and session lifetime. `CallbackAuthClient`
adds callback completion. Neither promises a Cloud dashboard. The existing
private bearer owner keeps offline restoration, credential verification,
serialized writes, same-person repair, retirement, and request/socket binding.
No second session state machine is needed for self-hosting.

Authority assignment belongs to trusted installation composition. A server
response or user-supplied principal cannot claim another issuer's namespace.
Changing an existing authority changes durable local addresses and requires an
explicit transition. Cloud's existing identity and physical layout remain fixed.

## Consequences

Callers must name the issuer identity at construction. Supporting a redirect
callback no longer implies Cloud billing or account management. Generic session
code can serve another issuer without importing its product policy.

This decision does not implement self-hosted admission, credentials, sessions,
or server installation configuration. Those remain in the
[library ownership execution plan](../../specs/20260909T004225-library-ownership-execution.md).

## Considered alternatives

- Default missing authority to Cloud: makes an omitted option select the wrong
  durable namespace instead of producing a type error.
- Derive every authority from the URL: changes existing Cloud bytes and invents
  identity continuity rules inside the session lifetime.
- Add a separate self-hosted session client: duplicates the Account owner and
  its cancellation, persistence, and retirement invariants.
- Keep Cloud dashboard links on every session client: advertises routes a
  self-hosted server does not implement.
