---
name: auth
description: 'Epicenter auth packages: `@epicenter/auth` and the Svelte wrapper at `@epicenter/svelte/auth`, OAuth sessions, identity state, auth-owned fetch/WebSocket, and record-replica attachment. Use when editing Epicenter auth clients, session state, hosted sign-in, or auth/data integration.'
metadata:
  author: epicenter
  version: '7.0'
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
Epicenter uses Better Auth for auth-server machinery, OAuth for the app/resource boundary, and AuthState{principalId} for attaching a local replica to a remote principal.
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
from `@epicenter/identity`). There is no `ownerId` / `OwnerId` in the codebase.
On a self-hosted instance every valid bearer resolves to the literal
`INSTANCE_PRINCIPAL_ID` (`'instance'`). If you see `owner` anywhere, it is stale
prose, not a symbol.

## Current Model: one dispatcher, three credential clients

App clients pick a credential model through one dispatcher,
`createAppAuthClient(instance, opts)`, which forks on whether a self-host
`instance.token` is present:

- `createOAuthAppAuth(...)` — the hosted default (no token). PKCE bearer +
  transparent refresh + a `/api/session` network gate + `openWebSocket`. Every
  cross-origin / native app uses this (web, extension, Tauri, CLI daemon).
- `createInstanceTokenAuth(...)` — a self-hosted star (static `instance.token`).
  No OAuth flow, launcher, refresh, or persisted grant; boots optimistically
  `signed-in` as `INSTANCE_PRINCIPAL_ID` and verifies `/api/session` in the
  background (surfacing the result on `deployment.connection`). Carries the
  bearer subprotocol, so it is a drop-in `SyncAuthClient`.
- `createSameOriginCookieAuth(...)` — the same-origin dashboard SPA
  (`apps/api/ui`). Uses the first-party Better Auth cookie directly; a plain
  `AuthClient` with no `openWebSocket`.

These are three credential models, not mode flags on one client. The old
`createCookieAuth` / `createBearerAuth` split (and `BearerSession` /
`auth.bearerToken`) is fully removed; do not reintroduce those names.

`createOAuthAppAuth` and `createInstanceTokenAuth` both attach a bearer, so they
share one internal transport: `fetchWithBearer` in
`packages/auth/src/bearer-fetch.ts`, parameterized on how each resolves its
token (the OAuth client's network gate vs the instance client's static token).
Do not re-duplicate the attach-bearer-only-to-the-signed-in-origin logic; route
new bearer clients through that helper.

The hosted OAuth factory in one shape:

```ts
const auth = createOAuthAppAuth({
	baseURL: EPICENTER_API_URL,
	clientId,
	launcher,
	persistedAuthStorage,
});
```

Apps rarely call these directly: the Svelte wrappers
(`createHostedBrowserRedirectAuth`, `createHostedDeepLinkAuth` in
`@epicenter/svelte`) build the launcher and call `createAppAuthClient` for you.

The public surface lives in one package plus a Svelte subpath:

- `@epicenter/auth`: framework-agnostic core. Owns the persisted auth cell,
  refresh, refresh-token revocation, `/api/session` verification, the network
  gate, authenticated fetch, and WebSocket opening. Also exports the Node
  machine-auth surface (`@epicenter/auth/node`) for CLI and daemons.
- `@epicenter/svelte/auth`: Svelte 5 wrapper in the `@epicenter/svelte`
  package. It mirrors `auth.state` through `createSubscriber` so templates and
  `$derived` reads are reactive, and provides the hosted browser and deep-link
  client factories.

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

## Public Surface

`AuthState` is defined in `@epicenter/identity` (MIT, so data clients and the
AGPL auth client share one definition across the license firewall) and
re-exported from `@epicenter/auth`:

```ts
export type AuthState =
	| { status: 'signed-out' }
	| { status: 'signed-in'; principalId: PrincipalId }
	| { status: 'reauth-required'; principalId: PrincipalId };

export type Deployment =
	| { kind: 'hosted'; baseURL: string }
	| { kind: 'self-hosted'; baseURL: string; connection: InstanceConnection };

export type InstanceConnectionStatus =
	| 'connecting'
	| 'connected'
	| 'unreachable'
	| 'rejected';

export type InstanceConnection = {
	get status(): InstanceConnectionStatus;
	onChange(fn: (status: InstanceConnectionStatus) => void): () => void;
};
```

The client contract (`packages/auth/src/auth-contract.ts`), trimmed of JSDoc:

```ts
export type AuthClient = {
	state: AuthState;
	deployment: Deployment;
	onStateChange(fn: (state: AuthState) => void): () => void;
	startSignIn(): Promise<Result<undefined, AuthError>>;
	signOut(): Promise<Result<undefined, AuthError>>;
	fetch(input: Request | string | URL, init?: RequestInit): Promise<Response>;
	getProfile(): Promise<Result<Principal, AuthError>>;
	[Symbol.dispose](): void;
};

// A bearer-carrying client that can also open authenticated WebSockets for sync.
export type SyncAuthClient = AuthClient & {
	openWebSocket(url: string | URL, protocols?: string[]): Promise<WebSocket>;
};
```

`AuthState` arms carry `principalId` directly. There is no nested identity
object and no `user` field in state: profile (the email) is fetched on demand
via `getProfile()` by the surface that displays it, never held in state.
`principalId` is present in `signed-in` and `reauth-required` because it is the
offline-useful attachment identity. Even when the OAuth grant needs reauth,
the local replica can still open and retain the principal it will attach to
when transport becomes available.

`deployment` is the one runtime owner of the hosted vs self-hosted fact,
fixed by the factory that built the client. UI branches on `deployment.kind`
instead of re-deriving the mode from the persisted `InstanceSetting`; only a
self-hosted deployment carries a live `connection` status (the boot bearer
check against the instance).

`SyncAuthClient` (adds `openWebSocket`) is the type authenticated record,
document, room, and relay transports require. The same-origin cookie client is
a plain `AuthClient`, so passing it where a bearer WebSocket is needed is a
compile error, not a runtime throw.

Read `auth.state` synchronously. Use `auth.onStateChange(fn)` for future changes
only; it does not replay. Consumers that need bootstrap behavior must read
`auth.state` once and then register the listener.

Do not expose raw tokens above auth storage and transport boundaries. UI,
replica attachment, AI fetches, and sync consume capabilities: `auth.fetch`
and `auth.openWebSocket`.

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
  principalId -> local replica attachment identity (offline-useful)
```

The grant lets the app call the server and is useless offline on its own.
`principalId` stays useful offline: it identifies the remote principal to which
the local replica will attach. Profile data is intentionally absent;
application surfaces fetch it via `getProfile()` when they display it.

The app can boot its local replica from a cached `PersistedAuth` without calling
the network. Refresh failure must preserve the cached `principalId` so the
intended remote attachment remains known. The principal id is not a decryption
key and does not gate access to local records.

## Network Gate (local-first invariant)

The runtime tracks a `networkAccess` state per signed-in cell (internal to
`createOAuthAppAuth`):

```txt
networkAccess: 'unverified' | 'verified' | 'paused'
```

`bearerForNetwork` is the gate. It NEVER attaches a bearer until `/api/session`
verifies the current persisted auth in this runtime:

```txt
signed-out / paused        -> no bearer
refresh stale grant        -> if refresh fails, no bearer (offline = fail closed)
unverified -> call /api/session
  ok                       -> mark verified, attach bearer
  Rejected (401/403)       -> pauseNetworkAuth() -> reauth-required
  Unavailable (offline)    -> no bearer; the local replica remains usable
```

Fail closed offline: server access is refused until the current persisted auth
has been verified by the API, but local replica boot continues independently.
A different-`principalId` `/api/session` response wipes the auth cell
(same-principal guard) rather than silently attaching the replica to another
principal.

`auth.fetch` layers retry on top of the gate: verify-before-attach,
`credentials: 'omit'`, one forced-refresh retry on a 401, and
`pauseNetworkAuth()` on a second 401.

## Sign-In Flow

Apps ask auth to start hosted sign-in. `startSignIn` takes NO arguments:

```ts
await auth.startSignIn();
```

The launcher decides how the runtime completes OAuth and returns one of two
shapes:

- `'launched'`: control moved to a redirect / deep-link callback. The browser
  redirect launcher navigates to the hosted `/sign-in` and usually does not
  resolve before the page unloads.
- `'completed'` with `{ grant }`: the launcher exchanged a token grant in
  process (extension, OOB CLI). The runtime then calls `/api/session`,
  resolves identity, and persists `PersistedAuth`.

The return value of `startSignIn` is not the "user is signed in" signal.
Observe `auth.state.status === 'signed-in'` for completion. (On the
instance-token client, `startSignIn` re-runs the `/api/session` verification so
a UI can retry a connection that was offline at boot.)

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

## CLI and Daemon (machine auth)

`packages/auth/src/node/machine-auth.ts` is the Node surface. One auth file per
API target lives at `<dataDir>/auth/<host>.json` with mode `0o600` (`:` in the
host replaced by `_`); `machineAuthFilePath({ baseURL })` resolves it. Loading
refuses a file whose permissions are wider than `0o600`.

- `loginWithOob(...)`: runs the OOB OAuth dance once, calls `/api/session` for
  the identity, persists `PersistedAuth`, and returns the email for CLI output.
  It deliberately BYPASSES `createOAuthAppAuth`: login is a one-shot human
  action, and routing it through the factory would double the round-trip count.
- `createMachineAuthClient(...)`: the daemon boot entry point. Loads the cell
  and constructs a normal `createOAuthAppAuth` client over a file-backed
  storage port. Its launcher errors on `startSignIn` (a human must run
  `epicenter auth login` to refresh the cell); daemons never sign in
  interactively.
- `resolveMachineAuthClient(...)`: chooses the client for a CLI/daemon run: a
  configured token yields an instance-token client, otherwise the machine cell.
- `status` / `logout`: read the cell and reach the server through a regular
  client. `status` returns `'unverified'` on network failure so the CLI can
  still print the cached identity.

## Transport

Use `auth.fetch` for HTTP resources:

```ts
const response = await auth.fetch(`${EPICENTER_API_URL}/api/ai/chat`, {
	method: 'POST',
	body,
});
```

`auth.fetch` runs the network gate (verify-before-attach), sends
`credentials: 'omit'` so OAuth tokens stay the resource credential, retries one
401 after a forced refresh, and pauses network auth on a second 401. Storage
writes are awaited before a refreshed token is used.

Use `auth.openWebSocket` for authenticated realtime transports:

```ts
const socket = await auth.openWebSocket(roomUrl, ['epicenter']);
```

Browsers cannot attach `Authorization` headers to `new WebSocket()`, so auth
carries the bearer token as a WebSocket subprotocol
(`BEARER_SUBPROTOCOL_PREFIX`). Each authenticated WebSocket surface extracts
that credential on upgrade (an explicit `Authorization` header wins; else
exactly one `bearer.<token>` entry) and feeds the bare token to the deployment's
`ResolveBearerPrincipal`. Nothing rewrites `c.req.raw`: Bun's `server.upgrade`
only accepts the runtime-minted request. The backend echoes only the selected
application subprotocol on every 101, so the token never round-trips.

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
   WS close 4401  -> permanent auth failure; client gives up
   WS close 4408/4503 -> transient; client reconnects with backoff
   HTTP 401 (InvalidToken)  -> discard and refresh the token
   HTTP 503 (ServerError)   -> retry; the token is fine, JWKS was unreachable
   ```

   Never flatten a JWKS-fetch failure into a 401, or a transient server fault
   makes clients discard and refresh a good token and pause network auth.

## Record Attachment

Lens-backed apps open their local record Epicenter whether signed in or out.
Sign-in may attach the whole replica to a deployment and principal; it never
creates an app-specific storage scope or gates local first paint.

The browser runtime reads `auth.state` when an attachment or authenticated
operation begins, then generation-fences the work to that principal. Abort or
refuse the result if identity changes before completion. If an existing replica
is attached to another deployment or principal, surface a blocking mismatch
instead of silently moving data.

Local records must not be wiped because network auth failed. Keep/discard on
first attachment is a separate explicit destructive choice. See
`lens-app-composition` for the Honeycrisp and Whispering runtime shape.

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

The deployment partition is a single unconditional path shape:
`principals/<principalId>/<type>/<id>`. Server-only durable names use one helper
per resource type (for example `attachHostDoName` in
`packages/server/src/principal.ts`). There is no `OwnershipRule` engine,
`perUser` / `instance` discriminator, or `resolveOwnerPartition` switch:
per-user vs instance is decided once, at the resolver, by which `PrincipalId`
the bearer resolves to (a real user id, or the literal
`INSTANCE_PRINCIPAL_ID`). Everything downstream is principal-blind.

Note: the same-origin dashboard SPA (`apps/api/ui`) uses
`createSameOriginCookieAuth`, not PKCE. Served same-origin by the API, it already
holds a first-party Better Auth session cookie after Google sign-in, so minting a
bearer (and an unused `offline_access` refresh token) via PKCE against its own
origin would be redundant. The cookie client uses that cookie directly
(`credentials: 'include'`, no `Authorization`), reads `/api/session` once for
`principalId`, and is a plain `AuthClient` (no `openWebSocket`: a billing surface
has no sync). It is the cookie-credential sibling of `createOAuthAppAuth`, not a
mode flag on it.

## Common Pitfalls

- Do not add `auth.bearerToken` or any token reader. Token reading leaks
  transport details back into app code.
- Do not reintroduce cookie-vs-bearer app factories. The three credential
  clients are chosen by `createAppAuthClient`, not by a mode flag; app resources
  use OAuth access tokens through `createOAuthAppAuth`.
- Do not treat `startSignIn()` resolving as signed-in. State is the source of
  truth; `startSignIn` takes no args.
- Do not clear local record data on refresh failure. Move to `reauth-required`
  (the runtime pauses network auth) and keep `principalId` available as the
  intended remote attachment identity.
- Do not let `accessTokenExpiresAt` decide local identity state. It is a
  transport refresh hint only; the resource server is the source of truth for
  token validity.
- Do not send both cookies and bearer tokens to resource routes. The two
  credentials are read by disjoint paths (`requireCookieOrBearerPrincipal`
  cookie-first, `requireBearerPrincipal` bearer-only) and never merge.
- Do not re-duplicate the bearer transport. Client-side, both bearer clients
  share `fetchWithBearer` (`bearer-fetch.ts`); server-side, the three guards
  share `setPrincipalOrReject` (`require-auth.ts`).
- Do not hide persistence failures in storage adapters. If `set` cannot save
  the refreshed cell, the failure must propagate, not silently look saved.
- Do not write `ownerId` / `OwnerId`. The identity word is `principalId` /
  `PrincipalId`; the instance principal is `INSTANCE_PRINCIPAL_ID`.
- Do not import `requireSignedIn`, `InferSignedIn`, `openFuji`,
  `encryptionKeys`, `EncryptionKeys`, `keyring`, `Keyring`, `toConnection`, or
  `reloadOnPrincipalChange`. They do not exist in Epicenter auth. Open the
  local replica independently, then use `auth.fetch` and
  `auth.openWebSocket` at the explicit remote attachment boundary.
