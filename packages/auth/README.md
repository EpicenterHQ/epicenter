# @epicenter/auth

Auth selects an account; every application session keeps the Account it opened with.

```ts
const auth = createBrowserOAuth({
	server: epicenterCloud('https://api.epicenter.so'),
	clientId: 'so.epicenter.vocab',
	resources: ['https://api.epicenter.so'],
	scope: 'openid profile email ai',
	accountManagement: true,
});
const state = auth.getState();
if (state.status !== 'signed-out') {
	const account = state.account;
	// Keep this Account for the lifetime of the opened application.
	const response = await account.fetch('/auth/oauth2/userinfo');
}
```

`Account` holds a fixed `principalId`, `authorityId`, and `baseURL`, an
authenticated `fetch`, and `getProfile`. Its object identity lasts through
token renewal and reauthentication by the same person. A browser navigation,
including the silent renewal's, creates a new runtime and application session.

Sign-out or account replacement permanently retires its network access.
Signing back in creates a new Account, even for the same person on the same
server. Retirement aborts HTTP requests and response streams. It cannot undo
an operation the server already processed.

`AuthClient` always exposes sign-in. `CallbackAuthClient` adds
`completeSignIn` for a client whose sign-in returns to a callback page.

## Server and authority

Each build has one configured `AuthServer`. `epicenterCloud(baseURL)` supplies
Cloud identity (`epicenter-api`); `selfHostedServer(origin)` derives the
authority from the configured origin. Both return only `{ baseURL,
authorityId }`. Matching principal IDs on two servers receive different
authorities, so their local data never mixes.

Browser app builds use `VITE_EPICENTER_SERVER` for a self-hosted origin. Without
it, they use the configured Cloud URL. Changing the destination requires a new
build and deployment.

## Browser apps

A first-party browser app signs in with `createBrowserOAuth` as an OAuth 2.1
public client of the deployment's authorization server (ADR-0549). Its
`clientId` is the app id, its redirect URI is exactly
`<app origin>/auth/callback`, and both must match the app's registration in
`apps/api/worker/oauth-registrations.ts`. It names its `resources` (token
audiences, from `resolveOAuthAudiences` in `@epicenter/constants/apps`) and
the scopes it needs. Each resource gets an access token of its own. The caller
never asks for `offline_access`.

`startSignIn` saves one PKCE attempt (verifier, state, and the current path) in
`sessionStorage` and navigates top level to `/auth/oauth2/authorize` with an
S256 challenge and every resource. The callback page calls `completeSignIn`,
which checks the state against the attempt (single use, ten minutes at most),
exchanges the code at `/auth/oauth2/token` for the first resource, reads the
principal from `/auth/oauth2/userinfo`, and stores the tokens. It returns
`returnTo`, the path the attempt started from, and the page leaves with
`location.replace(returnTo)`.

With more than one resource, the client adds `offline_access` to the one
redirect, then spends the refresh token once per further resource
(`grant_type=refresh_token` with that `resource`, RFC 8707), carrying the
rotated one forward, and drops the last. Whispering signs in this way for
transcription and its folder's Git remote. If any token request fails, the
sign-in fails, nothing is stored, and what was issued is revoked. The server
keeps a browser grant bound to its session and refuses a token that names more
than one audience (ADR-0549).

The access tokens live in `localStorage` with their expiries, the principal
ID, and a nonsecret attachment generation, one cell per app and server, shared
by the origin's tabs. Every request reads the cell, so a tab uses another
tab's renewal, and the `storage` event publishes another tab's sign-in or
sign-out. A missing or unreadable cell is signed out. The generation also retires an old Account when a tab misses a
sign-out event and the same person signs in again. No refresh token is stored.

By default, when the earliest stored token is within ten minutes of expiry, the client navigates top
level to the authorize endpoint with `prompt=none`: at construction, and from a
timer while the page is open. The timer rereads storage first and waits again
if another tab already renewed. An app with work that must survive a page
navigation can set `automaticRenewal: false`; it then asks the person to sign
in again after a refused token. While the authorization server's session cookie
lasts, the renewal returns a code without a page; otherwise it answers
`login_required`, and `completeSignIn` clears the token and returns to the
page signed out. There is no hidden iframe. A person who never signed in is
never redirected.

`Account.fetch` picks the token of the most specific resource the target
matches: the same origin, and a path equal to the resource's path or under it
(so `/github` is not under `/git`). Other requests to the server's origin use
the first resource's token, and any other origin is refused. It sends
`Authorization: Bearer <token>`, no cookies, `credentials: 'omit'`, and
`redirect: 'manual'`. A 401 publishes `reauth-required` on the same Account,
which refuses requests with the refused token until a new one for the same
person arrives.
`getProfile` reads the authorization server's `/auth/oauth2/userinfo`, which
answers `sub` for a token with `openid` and the email only for one with
`email`, so an app that shows the email asks for both.

`signOut` clears the tokens at once, then revokes each at `/auth/oauth2/revoke`,
waiting at most five seconds. A failed revocation is logged; the person is
signed out locally either way.

The dashboard is not an OAuth client: it is the authorization server's own
page and uses its session cookie.

## Desktop

The desktop app's sign-in is the `epicenter` CLI's desktop grant
(ADR-0556, ADR-0558). Settings signs in with `epicenter auth login --desktop`
and signs out with `epicenter auth logout`; the CLI keeps the refresh token in
the keychain and mints access tokens per resource. No WebView holds a token
(ADR-0549's desktop row). Compile the shell with `EPICENTER_SERVER_ORIGIN` for
a self-hosted build; the default is Cloud.

A bundled app's desktop leaf can use `createDesktopAccountAuth` from
`@epicenter/auth/desktop` over three shell commands its desktop leaf binds:
`auth_status` for who the desktop grant belongs to, `account_send` for each
account request, and `open_home` to send the person to Settings to sign in.
The grant's account id is the Account's `principalId` and the deployment
`auth_status` names is its `baseURL`; the build names no deployment of its
own, and any origin but the hosted one is a self-hosted server. The Account is
bound to one resource. Whispering's hosted route uses an API-bound Account for
`POST /v1/audio/transcriptions` and `POST /v1/chat/completions`; `getProfile`
uses that resource for `GET /auth/oauth2/userinfo`. The host grants only these
paths to its window. Its user-supplied provider route still uses its connection
sender. A Git-bound Account would use the Git resource for its own operations.

The desktop grant has a random, nonsecret generation that status returns and
every account send carries. The CLI checks it on the same read that selects a
cached token and again after taking a refresh lock. Replacing a grant,
including a new sign-in by the same person, retires the old Account. Its
requests and response streams are canceled on retirement. A 401 publishes
`reauth-required` on the same Account and stops later sends from it until
Settings installs a new grant. The client reads status when the window
regains focus by default. Whispering disables that watcher and awaits a fresh
read before capturing the Account for each hosted request. `signOut` is refused:
the app signs out from Settings. An explicit `refresh()` reports a status-read
failure to its caller and leaves the last Account in place; the CLI still
checks the grant generation before sending.

## Lifetime and policy

`AuthState` is signed-out, signed-in with an Account, or reauth-required with
that same Account. Store apps capture the Account once in their mounted working
owner and keep one App per working page. A Svelte app can export one
`fromAuth(client)` facade and read `auth.state` in both places: component setup
gets a snapshot, while a template, derived value, or effect tracks changes.
The plain client keeps its explicit `getState()` method; the Svelte facade
exposes `state` instead and carries through the other methods. A component with
imperative work on auth changes can subscribe directly with `onStateChange`.
Both expose `refresh()`: the browser rereads its saved OAuth cell, while the
desktop client rereads the host's grant status. A focus check can await the
same method in either build.

Use the plain client in framework-independent packages and CLIs with no Svelte
app owner, or when testing the core client. Its `getState()` call makes each
snapshot read explicit. In a Svelte app, keep that client private in the app's
auth module and export only the facade:

```ts
const client = createBrowserOAuth(options);
export const auth = fromAuth(client);
```

The callback route, components, and app-owned services can share that facade.
Read `auth.state` in component setup or an event handler for a snapshot; read
it in a template, derived value, or effect to track changes. The callback
capability guard `isCallbackAuthClient(auth)` also accepts the facade. Vocab's
[`auth.svelte.ts`](../../apps/vocab/src/lib/auth.svelte.ts) and Whispering's
[`#platform/auth` leaves](../../apps/whispering/src/lib/platform/) show the
single-export pattern for one browser build and for browser and desktop builds.

Ordinary persistence runs during use. Browser departures remove working UI and
replace the document without awaiting application drains. Honeycrisp still uses
`AppBoot` and its `?stopped` marker. Failed navigation and browser history
restoration cannot reactivate the retired working UI. Resource disposal and
acquisition rollback remain independent of navigation.

Access tokens last eight hours and are checked against the database on every
request, so a revocation takes effect on the next one (ADR-0549). The
authorization server's own session cookie works only on its own pages, where
sign-in, consent, and account changes happen.

Carry forward `src/browser-oauth.test.ts` and
`src/desktop-account-auth.test.ts` when changing a credential owner. After building the API UI,
`bun packages/auth/smoke/dashboard.browser.mjs` exercises the built
sign-in/callback/dashboard routes and a virtual WebAuthn authenticator while a
different principal owns the ambient browser cookie.

## Historical instance identity

Earlier installations saved a static bearer under the `instance` principal.
Current apps do not restore those credentials or old server preferences. They
leave historical local data untouched and do not assign it to a named person.
Self-hosted builds use the existing origin-derived authority bytes, so an
existing named user's local data keeps its address.
