# 0361. Hosted and instance credentials share one Account lifetime

- **Status:** Proposed
- **Date:** 2026-09-08

## Context

Hosted clients already acquire a signed session bearer, verify it through
`/api/session`, persist the verified identity, and publish an Account. The
Account owns authenticated HTTP and sockets for one uninterrupted attachment.
Self-hosted servers accept an operator token and return the literal `instance`
principal. That token is already a bearer credential; exchanging it for another
token adds no capability unless the server also manages individual sessions.

The earlier separate instance credential authority had no production callers.
It optimistically published identity before verification and duplicated
connection and credential state. Building a second application client around it
would have multiplied lifetime rules without changing feature authentication.

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

Server selection is a startup input. Browser documents and desktop processes
construct one credential owner for that selection and never retarget it. Before
showing connection choices, the application owner stops its UI producers and
awaits the captured App's close. Being signed out does not prove this: an app
can still have local data open.

Browser boot code owns that boundary and can reopen the original selection if
the person cancels. Desktop native asks every application document, including
hidden windows, to close and waits for acknowledgements. It blocks new app
windows while choosing. Failed close or timeout refuses replacement.

An active recording can refuse closure before teardown; stopping it permits a
retry. A failure from the App's terminal close keeps server selection unavailable.
Repeating that failed close does not repair persistence, and the client does not
reload to bypass it.

With no current app open, the connection form verifies a candidate in memory,
retires and drains the old credential owner, saves the selected credential, and
replaces the document or relaunches the host. The native storage queue checks
cancellation around asynchronous writes. Browser credential and selection writes
run synchronously, with rollback if saving the selection fails.

An instance origin is canonicalized before storage and encoded as its authority
ID. The authority ID and principal together identify an account: two origins
returning `instance` are separate accounts. URL aliases deliberately address
separate local data; no implicit alias migration or upload occurs. Hosted
clients use the deployment's configured authority identity.

Browser credentials are scoped by application and server origin. Desktop
selection and credentials occupy one native cell; WebViews receive only the
startup identity and brokered Account access. Browser token entry lives in the
shared connection form. Desktop token entry lives in Home Settings, and
instance app windows direct the person there.

## Consequences

Verification, ordered persistence, cancellation, offline restoration, request
and socket authentication, and Account retirement have one implementation.
Instance token entry replaces the unused instance authority and its private
grant protocol. Hosted handoff security and remote session revocation remain.

First connection requires the server to be reachable. Static-token holders
cannot revoke one device independently or obtain individual user partitions.
The first integration offers neither simultaneous server connections nor hot
server switching. These refusals remove session issuance and another routing
and lifecycle model while retaining connection to either deployment.

Shared authentication does not establish feature parity. The self-host Worker
mounts the shared store synchronization backend with its own Durable Objects
and the constant instance principal. The Bun entry has no store backend and
cannot provide cross-device store synchronization. Neither self-host entry
provides hosted billing or account management.

The scoped hosted browser credential key is a clean break. Existing credentials
under the old unscoped key are not restored; those browser clients sign in
again. This does not migrate or erase application data.

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

The AppBoot browser fixture holds both a UI producer and a real store commit;
connection controls remain absent until both settle. Recorder regressions cover
pending native finalization, VAD startup, and late model callbacks after stop.
Desktop tests cover request and window identity, close acknowledgements, launch
exclusion, cancellation, and failed credential persistence. Mail tests hold an
admitted write and authorization work through closure.

The browser smoke at `packages/auth/smoke/instance-connection.browser.mjs` drives
the real Honeycrisp form against a disposable local Worker, including rejection,
reload, synchronization, token reentry, and return to hosted sign-in. The actual
self-host Worker and Durable Objects are also exercised by
`packages/server/workers/selfhost.test.ts`. Packaged native callback and relaunch
verification remain separate from these local tests.
