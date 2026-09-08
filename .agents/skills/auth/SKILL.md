---
name: auth
description: 'Epicenter auth packages: `@epicenter/auth` and the Svelte adapter at `@epicenter/auth/svelte`, OAuth sessions, identity state, account-bound fetch/WebSocket, and how a boot node gates on identity without reloading. Use when editing Epicenter auth clients, session state, hosted sign-in, or how a route boots from auth.'
metadata:
  author: epicenter
  version: '9.0'
---

# Epicenter Auth

## Upstream Grounding

When changes depend on Better Auth OAuth provider behavior, bearer token
verification, cookie handling, token rotation, plugin shape, JWKS, or generated
API shape, ask DeepWiki a narrow question against `better-auth/better-auth`
before relying on memory. Use it to orient, then verify decisive details against
local installed types, source, tests, or official docs before changing code.

Known Better Auth source landmarks:

```txt
packages/oauth-provider/src/oauth.ts
packages/oauth-provider/src/authorize.ts
packages/oauth-provider/src/token.ts
packages/oauth-provider/src/revoke.ts
packages/oauth-provider/src/client-resource.ts
packages/better-auth/src/plugins/jwt/index.ts   (ES256 signing + JWKS)
```

Better Auth remains the auth server and session engine. Epicenter extends it
through plugins and options; it does not replace Better Auth's server-side
session model.

Use this composition sentence when explaining the architecture:

```txt
Epicenter uses Better Auth for auth-server machinery, OAuth for the app/resource boundary, and a stable Account for each data session.
```

That means Better Auth owns users, account cookies, login, consent, token
issuing, revocation, JWKS, and metadata. Epicenter clients store
`PersistedAuth`, not Better Auth sessions. `/api/session` is the adapter that
verifies a credential, resolves the request to a `principalId`, and returns
`ApiSessionResponse`.

When the user asks whether this is idiomatic Better Auth, be precise:

```txt
It is not the shortest Better Auth browser-cookie path.
It is an idiomatic composition of Better Auth as the auth server beneath a cross-client OAuth runtime.
```

Do not suggest removing Better Auth unless the user has a concrete blocker that
cannot be handled with configuration, a small adapter, or an upstream fix.
Building OAuth by hand means owning PKCE validation, redirect URI validation,
state and mix-up protections, trusted clients, token signing, refresh token
rotation, revocation, JWKS, metadata, consent, account sessions, and security
fixes forever.

## Vocabulary: principal, not owner

Client and server speak one identity word: `principalId` (branded `PrincipalId`
from `@epicenter/principal`). There is no `ownerId` / `OwnerId` in the codebase.
On a self-hosted instance every valid bearer resolves to the literal
`INSTANCE_PRINCIPAL_ID` (`'instance'`). If you see `owner` anywhere, it is stale
prose, not a symbol.

## Client composition

Read `packages/auth/README.md` and `packages/auth/src/auth-contract.ts` before
changing client API shape. The README owns the explanation; the contract owns
the signatures.

- Browser data apps compose `createHostedBrowserRedirectAuth`, or
  `createOAuthAppAuth` with their launcher and persisted storage. Auth selects
  an Account; that Account owns authenticated HTTP and WebSocket opening.
- Desktop windows use `createDesktopBrokerAuth`. Their Account forwards through
  the Bun host, which captures its boot Account and holds the remote credential.
  The host relays traffic and owns no application store or sync engine.
- The same-origin dashboard uses `createSameOriginCookieAuth`. It implements
  `AuthControls` and cookie HTTP, with no Account or sync socket stub.

`createInstanceCredentialAuthority` remains a lower-level static-token authority.
There is no `createInstanceTokenAuth` application client.

The Svelte subpath provides `fromAuth`, which adapts state and connection reads
through `createSubscriber`. Compose auth outside the adapter and retain the
callback-capable concrete client where the callback route needs it.

The API server composes Better Auth like this:

```txt
Hono app
  -> origin/trusted-origin resolution -> CORS
  -> /api/* CSRF guard for cookie mutations
  -> per-request DB (mountCloudDb)
  -> createAuth (mountCloudAuth): /auth/* Better Auth handler + /sign-in + /consent
  -> /api/session (mountSessionApp: requireCookieOrBearerPrincipal)
  -> protected resources (requireBearerPrincipal; rooms via requireRoomBearer)
```

`createAuth()` configures Better Auth with Drizzle (Postgres via Hyperdrive),
Google sign-in always, GitHub / Microsoft / Apple registered when their
credentials are present (Apple mints an ES256 client-secret JWT), and exactly
two plugins:

```ts
jwt({ jwks: { keyPairConfig: { alg: JWT_SIGNING_ALG } } }), // ES256
oauthProvider({
	loginPage: '/sign-in',
	consentPage: '/consent',
	requirePKCE: true,
	accessTokenExpiresIn: 600,
	validAudiences: [apiBaseURL],
	allowDynamicClientRegistration: false,
	scopes: [...EPICENTER_OAUTH_SCOPES],
})
```

There are no bearer, device-authorization, or custom-session plugins. Local
email/password is disabled (`emailAndPassword: { enabled: false }`): enabling
unverified local credentials reopens an account-linking takeover on
better-auth 1.5.6 (no `requireLocalEmailVerified` gate). Only Google is a
trusted linking provider; see the `better-auth-security` skill's Account
Linking note.

## Review the account lifetime

A data session keeps one person and one server for its entire lifetime.

`AuthClient` selects `state.account`; it exposes account commands and profile
presentation, not application HTTP or sync. `AuthControls` is the smaller
contract shared with cookie-only UI. `AuthIdentityState` is the serializable
principal projection used by credential authorities and desktop bootstrap.

When changing auth or a session consumer, verify these guarantees:

- Refresh, disconnection, and uninterrupted same-person reauthentication keep
  the same Account object within a running auth authority. Navigation or host
  relaunch creates a new authority and application session.
- Sign-out or account replacement permanently retires the old Account's
  network access. Signing back in as the same person produces a new Account.
- Retirement aborts HTTP and closes sockets. Authorization and retries check
  the captured account lifetime after awaits and before dispatch, so pending
  work cannot borrow a successor account's credential.
- Caller cancellation stops that request without canceling shared refresh.
- The account rejects foreign servers before attaching credentials.
- Retries, erase, blobs, and hosted inference use the session's captured
  Account, never a fresh read of mutable auth state.

Use `packages/auth/src/account-lifetime.test.ts` for browser lifetime races and
`apps/epicenter/src/account-transport.test.ts` for real loopback HTTP and sockets.
Distinguish a demonstrated application bug from a weak interface whose current
component lifetime prevents the bad call. Test the claimed failure schedule.

`onStateChange` reports future changes without replay. Read `auth.state`
synchronously to bootstrap. Only callback-capable clients expose
`completeSignIn`; callback routes narrow with `isCallbackAuthClient`.

## The Persisted Cell

`PersistedAuth` is the single durable auth record for the OAuth client
(`packages/auth/src/auth-types.ts`):

```ts
export const Principal = type({
	'+': 'delete',
	id: PrincipalId,
	'email?': 'string',
});

export const OAuthTokenGrant = type({
	'+': 'delete',
	accessToken: 'string',
	refreshToken: 'string',
	accessTokenExpiresAt: 'number',
});

export const PersistedAuth = type({
	'+': 'delete',
	grant: OAuthTokenGrant,
	principalId: PrincipalId,
});

export const ApiSessionResponse = type({
	'+': 'delete',
	principalId: PrincipalId,
	'email?': 'string',
});
```

The grant is a nested object; identity is a single `principalId`:

```txt
PersistedAuth
  grant: { accessToken, refreshToken, accessTokenExpiresAt }  -> online-only server access
  principalId -> local storage partition selection (offline-useful)
```

The grant lets the app call the server and is useless offline on its own.
`principalId` stays useful offline: it selects this principal's local workspace
data. Profile data is intentionally absent; application surfaces fetch it via
`getProfile()` when they display it.

The app can boot from a cached `PersistedAuth` without calling the network.
Refresh failure must preserve the cached `principalId` so local workspace data
stays available. The cached principal id selects the local storage partition; it
does not decrypt anything.

## Network gate

`createOAuthCredentialAuthority` verifies the persisted identity through
`/api/session` before authorizing resource traffic. Its account lifetime signal
is separate from its token generation: refresh replaces a token within an
account, whereas sign-out retires the account itself.

A rejected credential preserves the local identity and publishes
`reauth-required`. An unavailable server refuses network traffic without wiping
local storage. A verified different principal clears the old account.

`account.fetch` sends bearer requests with `credentials: 'omit'`, retries one
401 after refresh, and pauses network authorization on a second 401. Persisted
refresh writes complete before the token is used. Preserve replayable bodies
and check retirement across both attempts.

## Sign-In Flow

Two verbs, and they are not interchangeable. `startSignIn` BEGINS a flow and
`completeSignIn` CONSUMES a callback; neither takes arguments.

```ts
// any UI surface
await auth.startSignIn();

// the redirect route, and only there
if (isCallbackAuthClient(authClient)) await authClient.completeSignIn();
```

`startSignIn` used to be both. The browser launcher inspected
`window.location` for a `code` first, so the same call finished a sign-in on
`/auth/callback` and began one everywhere else, chosen by a query string, and
the callback route asked to START a sign-in in order to end one. Starting
always starts now: calling it on a callback URL mints a fresh PKCE transaction
and redirects, which is a loop rather than a subtlety.

The launcher decides how the runtime completes OAuth and returns one of two
shapes from `startSignIn`:

- `'launched'`: control moved to a redirect / deep-link callback. The browser
  redirect launcher navigates to the hosted `/sign-in` and usually does not
  resolve before the page unloads. Completion arrives later, through
  `completeSignIn` on the redirect route.
- `'completed'` with `{ grant }`: the launcher exchanged a token grant in
  process (the extension web-auth flow, the desktop host's deep link). The
  runtime then calls `/api/session`, resolves identity, and persists
  `PersistedAuth`.

Both halves share one in-flight sign-in, so two clicks are one launch and a
callback route that mounts twice is one exchange rather than an authorization
code spent and then replayed.

The return value of either is not the "user is signed in" signal. Observe
`auth.state.status === 'signed-in'` for completion.

`completeSignIn` resolving `Ok` means identity is installed and PUBLISHED, so
every reactive reader above the route has already seen it. Leaving the callback
URL is still the route's own job, and it does it unconditionally with
`window.location.replace(...)`, which also covers the callback that completed
for the principal already signed in: no state changed, so no reader moved. Use a document
replacement there rather than `goto`, or a client-side navigation opens the
store inside a document the browser is about to unload.

## PersistedAuthStorage Port

Storage is a small port (`packages/auth/src/persisted-auth-storage.ts`):

```ts
export type PersistedAuthStorage = {
	initial: PersistedAuth | null;
	set(value: PersistedAuth | null): void | Promise<void>;
};
```

`initial` is read exactly once, synchronously, at construction to seed the
state machine; it is never re-read. `set` is the only write path (no watch
hook: cross-context sign-out propagates via the server, where the next
bearer-bearing call hits a revoked token and reauth-requires organically).

Adapters:

- `createWebStoragePersistedAuthStorage({ key, storage })`: sync Web Storage
  (`localStorage` / `sessionStorage`). A corrupt record reads as signed-out
  instead of throwing; write failures propagate so an unpersistable credential
  fails its sign-in or refresh.
- `loadPersistedAuthStorage({ read, write })`: pre-load an async-backed store
  (extension `chrome.storage.local`, a file, the Tauri OS keyring) into a
  synchronous port. Await it before constructing the client so `initial` stays
  synchronous.
- `parsePersistedAuth` / `serializePersistedAuth`: the shared decode/encode
  helpers (re-validate against the arktype on both sides).

## Transport

App HTTP uses the captured `account.fetch`. Store synchronization receives the
same Account as its `SocketTransport`. The application owns the sync attachment
and closes it with the data session.

Browser OAuth transport verifies identity, attaches the bearer, and opens the
remote socket. `STORE_SYNC_ROUTE.address` supplies the URL and protocols;
`createOAuthAccount` adds the bearer subprotocol. Never expose a token reader to
application code.

Desktop window traffic goes through the authenticated loopback HTTP and sync
routes. The host validates its launch session, checks mutation/socket Origin,
fixes the upstream server to its boot Account, and strips ambient credentials.
The relay forwards bytes and closure; it does not reconnect or synchronize.
Sign-in and sign-out persist then relaunch the host. Keep the boot Account
captured even if relaunch fails, so an old window cannot use a successor account.

## Stateless access tokens and revocation windows

The OAuth provider issues JWT access tokens that the resource server verifies
statelessly against JWKS (no per-request introspection). That is fast, but it
means a token cannot be revoked before it expires: signing out revokes the
refresh token, not the already-issued access token. Three mitigations follow
from that one invariant and only make sense together. Treat them as a unit.

```txt
stateless JWT access token  ->  cannot revoke before exp
  1. short access-token TTL          (accessTokenExpiresIn: 600 / 10 min)
  2. bound WebSocket connection lifetime + force re-auth on reconnect
  3. classify verify failures: 401 (bad token) vs 503 (JWKS unreachable)
```

1. Keep `accessTokenExpiresIn` short (10 minutes). The client refreshes
   transparently (refresh tokens rotate; the runtime refreshes on a skew window
   and on any 401), so the UX cost is ~nil and the post-revocation window stays
   small.

2. A route that authenticates only at the WebSocket upgrade MUST bound the
   connection lifetime, or a socket opened with a valid token outlives the
   token. The rooms Durable Object closes an over-age socket and the client
   reconnects through a fresh authenticated upgrade. Crucially, a per-frame
   check misses idle sockets (their only traffic is the auto-responded `ping`),
   so the bound also needs an alarm-driven sweep over `getWebSockets()`.

3. Close codes and statuses carry meaning the client acts on:

   ```txt
   Refused upgrade          -> HTTP 401; the client reports the refusal on
                               `status().refusal` and dials again on backoff
   HTTP 401 (InvalidToken)  -> discard and refresh the token
   HTTP 503 (ServerError)   -> retry; the token is fine, JWKS was unreachable
   ```

   Never flatten a JWKS-fetch failure into a 401, or a transient server fault
   makes clients discard and refresh a good token and pause network auth.

## Boot selection

The boot node reads auth reactively, gates signed-out people, and keys the
session component on the Account object:

```svelte
{#if auth.state.status === 'signed-out'}
 <SignInScreen {auth} appName="Honeycrisp" noun="notes" />
{:else}
 {#key auth.state.account}
  <NotesSession account={auth.state.account} />
 {/key}
{/if}
```

The child captures its Account prop and calls `epicenter.open(account)`. It
closes on unmount and retries with that same Account. `createEpicenter` takes
the application id and definition, and opens nothing at construction.

Sign-out unmounts the child; account replacement remounts it. Refresh and
`reauth-required` preserve the Account and the mounted local session while the
application remains running. Do not key
on status or principal alone, and do not reload the browser document on each
auth change. The desktop host's account-change relaunch is a separate lifecycle.

Keep the gate below the layout shared with `/auth/callback`. Gate with UI rather
than a redirect so signed-out deep links retain their destination. A cached
replica can open offline; a device without a cached generation needs the server.
Local data is never erased because network auth failed.

## Server Routes and Deployment Seam

`/api/session` is mounted via `mountSessionApp(app, { auth })`, where the
deployment injects its auth middleware (`requireCookieOrBearerPrincipal` on the
cloud, `requireBearerPrincipal` on an instance). The endpoint serves both
browser apps and API clients. The handler returns `{ principalId, email }` from
`c.var.principal`.

Three bearer guards live in the server, differing only in how they extract the
bearer and how they render a rejection. They share one tail,
`setPrincipalOrReject(c, next, resolution, reject)` in
`middleware/require-auth.ts` (do not re-inline the destructure /
stamp-principal / render-error sequence):

- `requireCookieOrBearerPrincipal` — cookie-first (Better Auth session), else an
  `Authorization` bearer. `/api/session` and other dual-audience routes.
- `requireBearerPrincipal` — bearer-only; always answers 401 with a standard
  OAuth `WWW-Authenticate` header. External-only routes (AI chat).
- `requireRoomBearer` (in `routes/rooms.ts`) — extracts the bearer from the
  WebSocket subprotocol and renders a failure as a readable WS close, not an
  opaque HTTP error.

All three resolve the token through the deployment's `ResolveBearerPrincipal`,
which returns `Result<Principal, OAuthError>`. The cloud resolver
(`resolveRequestOAuthPrincipal`) verifies the JWT with `verifyJwsAccessToken`
from `better-auth/oauth2` against JWKS; an instance closes over its env-token
resolver instead.

```txt
audience = c.var.authBaseURL          (the API origin)
issuer   = <API origin> + /auth
jwks     = auth.api.getJwks()         (in-process; no HTTP hop to /auth/jwks)
```

A token-verification failure (expired, bad audience/issuer/signature, unknown
subject) is a real 401 (`OAuthError.InvalidToken`); an unreachable JWKS or DB is
a retryable 503 (`OAuthError.ServerError`). Never flatten the latter into a 401.

The deployment partition is a single unconditional path shape in
`packages/server/src/principal.ts`: `principals/<principalId>/<type>/<id>`, with
one helper per resource type (`doName`, `blobKey`, `blobPrincipalPrefix`). There
is no `OwnershipRule` engine, `perUser` / `instance` discriminator, or
`resolveOwnerPartition` switch: per-user vs instance is decided once, at the
resolver, by which `PrincipalId` the bearer resolves to (a real user id, or the
literal `INSTANCE_PRINCIPAL_ID`). Everything downstream is principal-blind.

Note: the same-origin dashboard SPA (`apps/api/ui`) uses
`createSameOriginCookieAuth`, not PKCE. Served same-origin by the API, it already
holds a first-party Better Auth session cookie after Google sign-in, so minting a
bearer (and an unused `offline_access` refresh token) via PKCE against its own
origin would be redundant. The cookie client uses that cookie directly
(`credentials: 'include'`, no `Authorization`), reads `/api/session` once for
`principalId`, and implements `AuthControls` plus cookie HTTP. It exposes no Account
or `openWebSocket`, because a billing surface has no sync. It is the cookie-credential sibling of `createOAuthAppAuth`, not a
mode flag on it.

## Common pitfalls

- Keep credential storage and refresh below Account transport. Do not add a
  token reader or duplicate bearer attachment at an app call site.
- Keep auth selection out of a data session's retry path. An old operation must
  not silently become work for the account currently selected in the UI.
- Treat network refusal separately from local identity. Token expiry is a
  refresh hint, not a reason to destroy local data.
- Propagate persisted-storage failures. A refreshed credential that could not
  be saved must not look durable.
- Use `startSignIn` to begin and `completeSignIn` to consume a callback. Observe
  published state for sign-in completion.
- Keep `@epicenter/auth/svelte` an adapter. Issuer, storage-key, and launcher
  conventions belong in the framework-independent composition.
- Keep reactive subscriptions lazy through `createSubscriber`; do not replace
  them with an eager shadow state and effect.
- Use `principalId` and `PrincipalId` for identity in code. Profile fields are
  fetched on demand and do not select the local partition.
