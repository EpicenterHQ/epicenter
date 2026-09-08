# 0361. Hosted and instance credentials share one Account lifetime

- **Status:** Proposed
- **Date:** 2026-09-08
- **Unbuilt:** Client server selection and token-entry UI, persisted server selection in the desktop host, and self-host store-sync integration.

## Context

Hosted clients already acquire a signed session bearer, verify it through
`/api/session`, persist the verified identity, and publish an Account. The
Account owns authenticated HTTP and sockets for one uninterrupted attachment.
Self-hosted servers accept an operator token and return the literal `instance`
principal. That token is already a bearer credential; exchanging it for another
token adds no capability unless the server also manages individual sessions.

The separate instance credential authority has no production callers. It
optimistically publishes identity before verification and duplicates connection
and credential state. Implementing a second application client around it would
multiply lifetime rules without changing how feature requests authenticate.

## Decision

Hosted sign-in and client-side instance token entry feed one Account lifetime.
The application receives an Account and does not inspect the credential kind.
Concrete hosted and instance constructors compose a private shared owner.
Credential acquisition stays inside the owner's cancellation boundary: acquire,
verify, persist, and publish are one attempt. The UI cannot assert a verified
principal or install a late result after disconnection.

The client selects one server before constructing that owner. Hosted sign-in
uses the existing browser/native handoff. Connecting to an instance accepts a
server URL and its existing operator token in the client. First enrollment must
successfully verify `/api/session`; only previously verified identity can be
restored offline. Unavailability refuses network traffic without discarding
that cached identity. Rejection pauses access until a valid credential arrives.

Self-host serves no login page, issues no device sessions, and offers no account
management. Its static token has no expiry. Disconnect retires local access and
forgets the saved credential. The operator rotates the server token to revoke
all holders. Hosted sign-out retains bounded best-effort remote session
revocation, also used for replaced and orphaned credentials. Credential release
is private composition policy, not a new public authentication framework.

One running client selects one server. Changing servers retires the old runtime
and reopens the application with a separate attachment. A server's stable
identity and its principal together identify an account: two servers returning
`instance` are not the same account. Server changes never imply data migration
or upload. Desktop credentials remain in the host; WebViews receive brokered
Account access, never the remote token.

## Consequences

Verification, ordered persistence, cancellation, offline restoration, request
and socket authentication, and Account retirement have one implementation.
Instance token entry can replace the unused instance authority and its private
grant protocol. Hosted handoff security and remote session revocation remain.

First connection requires the server to be reachable. Static-token holders
cannot revoke one device independently or obtain individual user partitions.
The first integration offers neither simultaneous server connections nor hot
server switching. These refusals remove session issuance and another routing
and lifecycle model while retaining connection to either deployment.

Shared authentication does not establish feature parity. Self-host must mount
and verify its store backend before the client can promise cross-device sync.
Until then, documentation must name that missing capability.

## Considered alternatives

- **A self-host login website accepting the existing token.** This relocates
  the form and adds a secure cross-application handoff without granting a new
  capability. The client can verify the same token directly.
- **Exchange the operator token for expiring device sessions.** This requires
  issuance, persistence, expiry, revocation, and device policy. Reconsider only
  for an explicit requirement to revoke devices separately.
- **A public generic credential framework.** Application authors need Account
  access and a concrete connection experience. Provider hooks and lifecycle
  callbacks would expose internal policy without simplifying those callers.
- **UI-owned credential installation.** This separates acquisition from the
  cancellation generation and permits late completion to reconnect a client.
- **An optimistic instance-only identity path.** Requiring first verification
  allows the existing cached-identity path to own offline behavior for both.

## Verification

Both credential sources must pass the same Account lifetime tests. Instance
cases additionally prove no remote revocation, failed first verification leaves
no identity, late token entry cannot reconnect after disconnect, and equal
principal strings on different servers do not permit credential forwarding.
Hosted cases retain bounded release of old and orphaned sessions. Client
integration must prove server-scoped persistence, explicit server replacement,
and preservation of the desktop credential boundary.
