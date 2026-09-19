---
name: auth
description: 'Epicenter auth packages: `@epicenter/auth` and the Svelte adapter at `@epicenter/auth/svelte`, direct sessions, identity state, account-bound fetch/WebSocket, and fixed library page bootstrap and deliberate departure. Use when editing Epicenter auth clients, session state, hosted sign-in, or how a route boots from auth.'
metadata:
  author: epicenter
  version: '10.0'
---

# Epicenter auth

Better Auth owns hosted sessions and social-provider login. Epicenter clients
hold signed session bearers behind stable Accounts. Self-hosted instances issue named-user sessions after passkey sign-in.

Read `packages/auth/README.md` and `packages/auth/src/auth-contract.ts`
before changing client API shape. The README owns the explanation; the contract
owns the signatures. Do not reconstruct OAuth grants, refresh-token rotation,
client registrations, or a cookie-only dashboard client.

## Ground external behavior

When correctness depends on Better Auth sessions, cookies, plugins, freshness,
or provider linking, ask DeepWiki a narrow question against
`better-auth/better-auth`, then verify decisive details against the installed
source, types, tests, or official docs. Online examples may target another version.

Useful installed source landmarks are the bearer plugin, API session routes,
API dispatch, internal adapter, and social callback routes. Epicenter's
`packages/server/src/auth/session-handoff.ts` is a small issuance plugin,
not a replacement session engine.

Global before-hooks run before plugin before-hooks. A management gate cannot
assume bearer normalization has happened: use the public session API with
explicit headers and test a real header-only request. Distinguish a rejected
credential from a database failure; a transient fault must not retire good identity.

## Client composition

Browser apps use `createBrowserRedirectAuth({ appId, server })` with one
build-configured `AuthServer`; the dashboard uses `createHostedBrowserRedirectAuth`.
Never restore a server destination from saved preferences. Credentials must
match the configured origin before publishing identity or making requests.
The framework-independent `createSessionAuth` composes a launcher and
persisted storage. It owns credential verification, ordered persistence,
cancellation, and Account retirement in one runtime.

Desktop WebViews use `createDesktopBrokerAuth`. Bun holds the remote session
and captures its boot Account. A failed relaunch must not give old windows the
replacement Account. The host owns no application store or sync engine.

The Svelte adapter `fromAuth` makes state reads track through
`createSubscriber`. Keep issuer, storage, and launcher conventions outside it.
Retain the callback-capable concrete type where a callback route needs it.

## Account lifetime

An application session keeps one person and one server for its entire lifetime.

`AuthClient` selects `getState().account`; it exposes sign-in, sign-out, profile,
and state. Application HTTP and sockets use the captured Account.
`AuthIdentityState` is the serializable principal projection for desktop
bootstrap, with no credential or transport functions.

Preserve these guarantees:

- Disconnection and uninterrupted same-person reauthentication keep the same
  Account object. Navigation and host relaunch create new runtimes.
- Sign-out or account replacement permanently retires the old Account.
  Later sign-in creates a new Account even for the same principal.
- Retirement aborts HTTP and response streams and closes sockets. Pending
  authorization and retries check the captured lifetime after awaits.
- Caller cancellation stops that request without cancelling shared verification.
- An Account rejects foreign origins before attaching credentials and does not
  follow redirects. Ambient cookies cannot choose another principal.
- Retry, erase, blob, and inference work uses the captured Account, never a new
  read of mutable auth state.

Use `packages/auth/src/account-lifetime.test.ts` for lifetime schedules and
`apps/epicenter/src/account-transport.test.ts` for real loopback HTTP and sockets.
Retain delayed blob and stream regressions when replacing credential fixtures.

## Persisted identity and network access

`PersistedAuth` is exactly `{ token, principalId }`. The session token
authorizes online access; the cached principal selects the local data partition.
It is not an offline decryption key. Profile data is fetched on demand.

`PersistedAuthStorage` has a synchronous `initial` snapshot and
`set(value | null)`. The runtime reads initial once and serializes writes.
Browser storage and preloaded native serialized storage adapt that port.
Do not add old-format readers or suppress write failures.

A cached principal can boot local data without network access. Before first
resource use, `/api/session` must confirm that the credential belongs to it.
A rejection preserves local identity and publishes `reauth-required`.
An unavailable server refuses traffic without deleting identity. A verified
different principal retires and clears the old attachment.

`account.fetch` uses `credentials: 'omit'`. A 401 pauses that credential;
retry once only if same-Account reauthentication installed another credential
while the request was in flight. Preserve replayable bodies and check retirement
before either dispatch. There is no automatic refresh exchange.

Sign-out retires locally immediately, clears persistence, and awaits a
best-effort revocation attempt bounded to five seconds. Success does not confirm
remote revocation. Replacement awaits old-token cleanup outside the storage
queue so sign-out can still clear storage promptly. Native relaunch awaits the
auth operation; do not turn revocation into fire-and-forget before process exit.

## Sign-in and handoff

`startSignIn` begins a flow. `completeSignIn` consumes a callback; do not
make one verb infer the other from a query string. Only callback-capable clients
expose completion, narrowed with `isCallbackAuthClient`.

A launcher returns `{ status: 'launched' }` for browser navigation or
`{ status: 'completed', token }` for in-process native completion.
The runtime verifies the token, persists it, and publishes the Account.
Repeated same-kind calls share one in-flight operation.

Success from completion means the identity is installed and published. The
callback route must still leave with `window.location.replace(...)`,
including same-principal completion where no identity event fires.
Do not open an application store inside the departing callback document.

`startSignIn({ reauthenticate: true })` bypasses passive hosted Continue
and asks for a completed provider/passkey sign-in. It must not sign out first,
because uninterrupted same-person reauthentication preserves the Account.

The hosted handoff has exact approved callbacks, state, S256 PKCE, atomic
single-use consumption, and short code expiry. URLs carry code and state, never
a session token. Redemption creates an independent revocable session and
inherits the source authentication age. Preserve shared transaction versions
and local cancellation generations: old responses cannot overwrite new choices,
even after the newer transaction completes. Revoke orphaned results where possible.

Native callback waiting must exist before opening the browser. Cancellation,
timeout, disposal, and opener failure must clear waiters and queued callbacks.
The remote session remains in Bun, never a WebView bootstrap.

## Dashboard and management

The dashboard uses the same captured Account composition as browser apps.
Key its mounted child and query cache on the Account object, not principal alone.
Late profile, billing, or mutation results must stay with the old attachment,
including sign-out followed by same-person sign-in.

The management client sends its captured Account bearer and expected principal.
Hosted cookie auth belongs to the sign-in page. Preserve provider and passkey
ceremonies without ambient-cookie fallback in dashboard operations.

Only the browser adapter enables challenge/state cookies for the exact
same-origin `/auth/link-social`, `/auth/passkey/generate-register-options`, and
`/auth/passkey/verify-registration` routes, with captured bearer and expected
principal headers already attached. Their guard must resolve the explicit
bearer before library cookie reads. Keep all other Account traffic cookie-free.

Sensitive changes require a live session younger than 600 seconds and the
matching principal. Renewal and passive handoff do not reset authentication age.
Ordinary social sign-in, including provider SSO, may create fresh permission;
do not describe this as human-presence verification. A stolen fresh bearer has
the same authority when presented as the signed session cookie.

Provider linking binds the principal at authorized initiation. Later sign-out
cannot undo an already-authorized linking operation. Test callback binding and
implicit same-email linking separately; they have different policy gates.

## Resource validation and socket bounds

Hosted resource routes use `requireBearerPrincipal` with
`resolveRequestSessionPrincipal`. The resolver calls Better Auth with only
the explicit bearer and live session lookup. No cookie fallback or JWT verifier
remains. `/api/session` is the resource identity projection, not another session engine.

Unknown, expired, or revoked credentials are 401. Database and infrastructure
failures are retryable 503. The self-host deployment supplies its static-token
resolver to the same resource guard and resolves valid tokens to
`INSTANCE_PRINCIPAL_ID`.

Hosted sessions have a 30-day sliding expiry, updated after one day of use.
Verify renewal through resource traffic, not only a direct helper call.
Deployments need isolated session stores and secrets; client origin checks do
not replace server-side deployment isolation.

A store socket is authenticated at admission and receives a server-computed
600-second deadline. Preserve deadline attachment across hibernation and cursor
updates, check all input/output paths, and sweep idle sockets with an alarm.
Revocation rejects the next admission; it is not immediate closure of all
admitted sockets. Percent-encode signed tokens in bearer subprotocols because
signature padding is illegal in raw WebSocket protocol names.

## Boot selection

The mounted AppBoot instance reads the plain client's `getState()` once and
opens one captured App from the inert definition. Imports and preloads acquire
no App. Keep reactive `.state` reads in UI modules adapted with `fromAuth`.
Callbacks and sign-in routes acquire no primary App.

Honeycrisp and Whispering support signed-out local startup. Vocab requires an
Account. Honeycrisp's Local and Personal routes display the nested handles on
one App. One warning before explicit account changes authorizes interruption of
active recordings and unsaved drafts, including work started while sign-in is
pending. Desktop acceptance disposes the boot auth owner, serializes next-boot
credentials behind its queued writes, awaits bounded token revocation, and
restarts. Cancellation before acceptance leaves working windows open. The
process never installs a successor Account; failed writes or restart keep old
access fenced, and new pages show restart-required UI.

Browser departures make the UI inert and replace the document without waiting
for producer or persistence drains. Deliberate sign-out marks departure before
calling auth: its retirement notification must not navigate before credential
clearing and bounded revocation finish. Unexpected retirement navigates to
`?stopped`; check that marker before calling `openApp`. Recovery opens no App
until explicitly requested. A cancelled navigation or history restoration must
not reactivate the old App. Preserve component disposal, acquisition rollback,
account fences, and independent source-library transfer lifetimes.
