# 0354. Hosted applications authenticate with Better Auth session bearers

- **Status:** Proposed
- **Date:** 2026-09-07
- **Relates:** [ADR-0331](0331-whispering-authenticates-with-an-oauth-bearer-on-every-surface.md) and [ADR-0071](0071-oauth-is-hosted-only-a-custom-instance-requires-a-token.md), whose hosted OAuth-provider requirement is being reconsidered.
- **Implementation:** Local replacement and verification recorded below. Proposal status is unchanged; implementation does not approve the record.

## Context

Epicenter's first-party applications have the same access to a person's hosted
resources. The resource guard resolves a credential to a principal. It does not
enforce different application scopes. Registered clients request the same
identity and offline-access scopes and skip consent.

Before this replacement there were two OAuth relationships:

```txt
Google / GitHub -> Epicenter
  Better Auth verifies the provider response and creates an Epicenter session.

Epicenter -> an Epicenter application
  Epicenter issues an OAuth access token and refresh token to that application.
```

The second relationship introduced another credential lifecycle. Browser apps
used `createHostedBrowserRedirectAuth`. The desktop's
`createDesktopAuthAuthority` held an OAuth grant and carried HTTP and sync for
its WebViews. The dashboard used the now-deleted `createSameOriginCookieAuth`
and the browser's ambient Better Auth cookie.

```txt
BEFORE: THREE APPLICATION PATHS

                       Google / GitHub
                              |
                       Better Auth login
                              |
                    Hosted browser session
                              |
           +------------------+------------------+
           |                  |                  |
      Browser SPA        Desktop host       Dashboard SPA
           |                  |                  |
     Epicenter OAuth    Epicenter OAuth     Session cookie
     code exchange      code exchange      sent by browser
           |                  |                  |
     Access + refresh   Access + refresh    Cookie-specific
     grant in browser   grant in host       auth client
           |                  |                  |
     Account.fetch      WebView -> broker    auth.fetch
           |                  |                  |
     OAuth bearer       OAuth bearer        Ambient cookie
           |                  |                  |
     JWT verification   JWT verification    Session lookup
           |                  |                  |
           +------------------+------------------+
                              |
                           Principal
                              |
                     Epicenter resources
```

The Account and desktop-relay implementation is recorded by commits
`dca1909f60` and `f272e2ae34`. Its lifetime decision is described in
[ADR-0353](0353-a-data-session-keeps-one-account-for-its-entire-lifetime.md).
This replacement changes the credential mechanism underneath that contract.
ADR-0353 now records the dashboard's implemented Account adoption.

The `Account` contract in `packages/auth/src/auth-contract.ts` binds operations
to one uninterrupted attachment to a person on a server. Ambient cookies cannot
make that promise. Alice can start an operation, another tab can sign in as Bob,
and the delayed request can carry Bob's cookie. Checking the session before the
request leaves the same race between the check and dispatch.

ADR-0331 chose the existing OAuth path for browser and desktop consistency. Its
claim that Tauri requires Epicenter to provide OAuth is too strong. Tauri needs
a protected sign-in handoff and a usable credential. A Better Auth session
bearer can supply the credential. The protected handoff still has to exist.

The execution premise is a clean break: no active users, no logged-in clients,
and no requirement to preserve old installations. Intermediate builds may be
broken. Existing grants need no exchange, and old credential formats need no
reader or staged rollout.

## Decision

**Every hosted application uses an explicit Better Auth session credential
through the same `Account` contract.**

This covers standalone browser SPAs, SPAs in the Epicenter desktop WebView,
and the dashboard SPA. A session bearer is an Epicenter session token carried
in an authorization header, not a Google token or an Epicenter OAuth JWT.

```txt
IMPLEMENTED: ONE SESSION MODEL

                       Google / GitHub
                              |
                      Better Auth sign-in
                              |
              Protected issuance of a client session
                              |
           +------------------+------------------+
           |                  |                  |
      Browser SPA        Desktop host       Dashboard SPA
           |                  |                  |
     Browser holds      Host holds         Browser holds
     session token      session token      session token
           |                  |                  |
           |            WebView calls            |
           |            the host broker          |
           |                  |                  |
           +------------------+------------------+
                              |
                    Same Account contract
              fetch / openWebSocket / getProfile
                              |
                    Explicit session bearer
                              |
                  Better Auth session validation
                              |
                           Principal
                              |
                     Epicenter resources
```

**Better Auth owns the hosted credential lifecycle.**

It owns session creation, renewal, expiry, and revocation. Epicenter removes
its OAuth-provider plugin, grant lifecycle, and provider-only registrations,
consent, discovery, and JWT verification. Better Auth continues handling social
sign-in, provider callbacks, account linking, and passkeys. Provider credentials
and any JWT signing those providers need remain.

One session model does not mean one global token. Each browser client and
desktop installation has an independent session. Desktop windows share the
host's captured account through the broker. Issuance preserves the source
session's `createdAt`, and renewal changes expiry without resetting freshness.
Sensitive changes use ordinary Better Auth session freshness as described in
[ADR-0356](0356-sensitive-account-changes-use-better-auth-session-freshness.md).
A completed social sign-in can establish freshness through provider SSO;
Epicenter does not separately prove recent password or biometric interaction.

**The credential runtime owns a captured `Account` independently of the server
session's expiry.**

The existing `Account` members remain `principalId`, `baseURL`, `fetch`,
`openWebSocket`, and `getProfile`. Within a running auth authority, session
renewal and temporary disconnection preserve its object identity. Browser
navigation and desktop host relaunch create a new runtime and app session.
Reauthentication within the running authority preserves Account only when the
verified principal matches and the attachment has not been retired. Sign-out
or account replacement permanently retires it, including pending requests,
response streams, and sockets. A later sign-in creates another attachment,
even for the same person. Auth failure never erases local application data.

**Browser apps and the dashboard use the same browser composition.**

Resource requests omit ambient cookies and attach the captured session bearer
only to the configured server. An invalid bearer never falls back to a browser
cookie. The dashboard no longer forces an `AuthControls` contract that lacks
an account. Its billing requests and query state belong to the captured account
just as a notes session's operations do.

**The desktop host retains the credential and the WebView retains the account
interface.**

The host owns credential persistence and carries remote HTTP and WebSocket
traffic. Its relay uses its captured boot account, including while a replacement
is being persisted before relaunch. The WebView receives no session secret.
The loopback cookie protects access to the local broker; it is not a second
hosted credential. Applications continue owning their stores and sync.

**Hosted authentication ceremonies keep their browser boundary.**

Google/GitHub sign-in and passkey ceremonies can use Better Auth cookies on the
hosted auth origin. The protected handoff binds a short-lived, single-use code
to the initiating client and its exact callback, using PKCE and state. A raw
session token never travels in a redirect URL. Native sign-in opens the system
browser. Browser and native launchers adapt this one handoff to their callback
and storage mechanisms.

Login-method changes and account deletion require an active session within the
ten-minute freshness window for the same principal as the invoking account.
Opening a browser that holds another person's cookie cannot retarget the
operation. Optional passkeys and provider linking remain available. No email
confirmation, mandatory enrollment, or per-app permission system is introduced.

**The replacement is implemented without credential compatibility.**

Only the new session format is read. Old grants, OAuth client IDs, token
conversion endpoints, dual validators, and migration flags have no destination
in the final design. Development fixtures can be recreated. Temporary compiler
failures are allowed; the final result must pass account-isolation, sign-in,
HTTP, and sync checks.

## Consequences

| What collapses | What remains |
| --- | --- |
| Browser/dashboard auth-model split | Browser storage and native host storage |
| OAuth grant plus Better Auth session lifecycles | Better Auth session renewal and revocation |
| Access-token refresh, rotation, and refresh-token persistence | Cached principal for local state and reauthentication |
| Cookie-first/JWT resource resolution | One session-bearer principal resolver for hosted resources |
| Epicenter OAuth registrations, scopes, and discovery | Trusted callbacks and provider configuration for sign-in |
| Compatibility readers and staged credential migration | Final verification of the new path |

The dashboard's application credential becomes accessible to its JavaScript.
It loses the HttpOnly protection of its former application session cookie.
The desktop keeps its secret outside the WebView. Origin checks, callback
validation, and transport credential handling remain necessary.

A stolen fresh session bearer can also authorize sensitive account changes.
The signed bearer can be supplied as a Better Auth session cookie, so a
cookie-only route is not an additional credential boundary. Personal-device
use is a trust assumption, not protection against remote credential theft.
The session-freshness decision states this exposure explicitly.

A trusted application can use the same browser path from an independently
operated domain after explicit callback and origin approval. Repository
ownership and hosting location do not require an OAuth-provider layer. The
trust decision still matters: giving an untrusted client limited, delegated
access would reopen this decision. Removing registrations must not remove
callback allowlisting or browser-origin controls.

A session bearer is a longer-lived secret than the former short access token.
WebSocket admission must validate it without echoing or logging it. Revoking
the database session does not close a socket already admitted. The replacement
uses a 600-second socket authorization deadline and validates again on reconnect,
including when a Durable Object hibernates. Changing token types does not
provide immediate cross-device logout.

Session duration and renewal are user-visible policy. Sessions expire after
30 days and extend after one day of use, including ordinary resource traffic.
Renewal preserves the authentication age used for sensitive changes.

Self-host remains one operator-supplied static bearer resolving to `instance`.
It does not acquire Better Auth or a hosted login flow. This change concerns
the three hosted application surfaces, not the deployment partition model.

## Implementation and verification

The local implementation is committed in `0c329cbb54` and `23bade0df4`.
Better Auth 1.6.23 owns signed sessions. The issuance plugin binds a 120-second
single-use code to S256 PKCE, state, and an exact approved callback. It creates
an independently revocable session with the source authentication age.
A successful live source-session lookup authorizes issuance. Revocation after
that lookup can race with session creation: an already-authorized independent
session may finish issuing and is not automatically revoked with its source.
The fresh Postgres baseline removes Epicenter OAuth and JWKS tables. No shared
database was reset or migrated, and nothing was deployed.

`createSessionAuth` owns verification, serialized persistence, cancellation,
and permanent Account retirement. Sign-out retires locally immediately and
waits up to five seconds for best-effort remote revocation. Failure or timeout
is logged; success does not confirm remote revocation. Credential replacement
awaits the same bounded cleanup outside the storage queue before completion.
Native relaunch waits for that completion.

The dashboard keys its query cache on the Account object. Its browser adapter
permits challenge/state cookies only for same-origin `/auth/link-social`,
`/auth/passkey/generate-register-options`, and
`/auth/passkey/verify-registration` requests with captured bearer and expected
principal headers. Their guard checks the explicit credential before library
cookie reads. Resource traffic omits cookies.

Verification includes disposable Postgres redemption races across two Bun
processes, real mounted bearer and management routes, renewal and independent
revocation, and Workers idle/hibernation deadline tests. The final client/app/
dashboard/billing run passed 150 tests; desktop tests passed 118, and four Rust
auth tests passed. Affected typechecks and the API UI production build passed.
The full workspace typecheck still fails in four pre-existing Skills test
fixtures missing `openWebSocket`.

Both opt-in Chromium smokes under `packages/auth/smoke/` passed. They cover
actual navigation, persisted handoff state, CORS, encoded WebSocket admission,
the built hosted sign-in and dashboard callback routes, and virtual passkey
registration/rename for Alice while the ambient cookie belongs to Bob.

Live Google, GitHub, Microsoft, and Apple provider flows were not exercised.
Fixtures do not prove provider configuration or provider SSO behavior in a real
account. Packaged Tauri login, OS deep-link delivery, real keychain writes,
physical authenticators, and actual process relaunch remain untested
interactively. The local dev launcher origin is tested without starting its
Infisical-backed services. These are release smoke requirements, not claims
established by the local harnesses.

Account deletion still lacks a store-authority erasure step. The freshness gate
tests authorize deletion; they do not prove complete data erasure. Socket
expiry limits access, not data retention. That pre-existing gap needs separate
implementation.

## Considered alternatives

- Keep OAuth as the permanent first-party boundary. Its separate grants do not
  express resource permissions these applications use. Its protected handoff
  remains a responsibility the session replacement must prove.
- Keep the dashboard's ambient cookie behind the same `Account` type. A cookie
  can change underneath a captured account. Enforcing attachment identity on
  every cookie request adds another resource transport to maintain.
- Enable `bearer()` beside OAuth. The plugin accepts Better Auth session
  tokens, not OAuth JWTs. Keeping both preserves two credential lifecycles.
- Remove all cookies. Hosted provider and passkey ceremonies and the private
  desktop broker still have browser-specific work to do. Their cookies do not
  require a second application account model.
- Share the hosted browser's session token with every client. Sign-out,
  expiry, and session management become coupled across installations.
- Convert old grants or stage a dual-auth rollout. There are no active
  sessions or installations to carry across the break.
