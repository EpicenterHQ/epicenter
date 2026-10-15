# @epicenter/auth

Auth selects an account; every application session keeps the Account it opened with.

```ts
const auth = createBrowserOAuth({
	server: epicenterCloud('https://api.epicenter.so'),
	clientId: 'so.epicenter.vocab',
	resource: 'https://api.epicenter.so',
	scope: 'openid profile ai',
	accountManagement: true,
});
const state = auth.getState();
if (state.status !== 'signed-out') {
	const account = state.account;
	// Keep this Account for the lifetime of the opened application.
	const response = await account.fetch('/api/session');
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
`apps/api/worker/oauth-registrations.ts`. It asks for one `resource` (the token
audience, from `resolveOAuthAudiences` in `@epicenter/constants/apps`) and the
scopes that audience allows. It never asks for `offline_access`.

`startSignIn` saves one PKCE attempt (verifier, state, and the current path) in
`sessionStorage` and navigates top level to `/auth/oauth2/authorize` with an
S256 challenge. The callback page calls `completeSignIn`, which checks the
state against the attempt (single use, ten minutes at most), exchanges the code
at `/auth/oauth2/token`, reads the principal from `/auth/oauth2/userinfo`, and
stores the token. It returns `returnTo`, the path the attempt started from,
and the page leaves with `location.replace(returnTo)`.

The access token lives in `localStorage` as `{ accessToken, expiresAt,
principalId }`, one cell per app and server, shared by the origin's tabs. Every
request reads the cell, so a tab uses another tab's renewal, and the `storage`
event publishes another tab's sign-in or sign-out. A missing or unreadable cell
is signed out. There is no refresh token.

When the stored token is within ten minutes of expiry, the client navigates top
level to the authorize endpoint with `prompt=none`: at construction, and from a
timer while the page is open. The timer rereads storage first and waits again
if another tab already renewed. While the authorization server's session cookie
lasts, the renewal returns a code without a page; otherwise it answers
`login_required`, and `completeSignIn` clears the token and returns to the
page signed out. There is no hidden iframe. A person who never signed in is
never redirected.

`Account.fetch` sends only to the server's origin, with
`Authorization: Bearer <token>`, no cookies, `credentials: 'omit'`, and
`redirect: 'manual'`. A 401 publishes `reauth-required` on the same Account,
which refuses requests until a new token for the same person arrives.
`getProfile` reads `/api/session`, so the app's audience must serve it.

`signOut` clears the token at once, then revokes it at `/auth/oauth2/revoke`,
waiting at most five seconds. A failed revocation is logged; the person is
signed out locally either way.

The dashboard is not an OAuth client: it is the authorization server's own
page and uses its session cookie.

## Desktop

The desktop app's sign-in is the `epicenter` CLI's desktop grant
(ADR-0556, ADR-0558). Settings signs in with `epicenter auth login --loopback`
and signs out with `epicenter auth logout`; the CLI keeps the refresh token in
the keychain and mints access tokens per resource. No WebView holds a token
(ADR-0549's desktop row). Compile the shell with `EPICENTER_SERVER_ORIGIN` for
a self-hosted build; the default is Cloud.

An installed app's window uses `createDesktopAccountAuth` from
`@epicenter/auth/desktop` over three shell commands its desktop leaf binds:
`auth_status` for who the desktop grant belongs to, `account_send` for each
account request, and `open_home` to send the person to Settings to sign in.
The grant's account id is the Account's `principalId` and the CLI's deployment
is its `baseURL`. `Account.fetch` carries a request below `/api/` to the CLI
with the resource the app names (`git` for Todos' `POST /api/git/connect`),
and the CLI adds the token for it; `getProfile` reads `/api/session` with the
`api` resource. A 401 publishes `reauth-required` on the same Account. A new
grant, including the same person signing in again, opens a new Account, and a
grant that is gone retires it. The client reads the grant again when the
window regains focus. `signOut` is refused: the app signs out from Settings.

## Lifetime and policy

`AuthState` is signed-out, signed-in with an Account, or reauth-required with
that same Account. Store apps capture the Account from the plain client in
their mounted working owner and keep one App per working page. Svelte adapts
auth with `fromAuth` for UI tracking through its reactive `.state` getter.
The raw client exposes the explicit snapshot method `getState()`. Ordinary
persistence runs during use. Browser departures remove working UI and replace
the document without awaiting application drains. Whispering signs out in a
resource-free route so credential clearing can finish after the working UI
unmounts. Unexpected retirement enters its resource-free recovery route;
reopening requires an explicit action. Honeycrisp still uses `AppBoot` and its
`?stopped` marker. Failed navigation and browser history restoration cannot
reactivate the retired working UI. Resource disposal and acquisition rollback
remain independent of navigation.

Access tokens last eight hours and are checked against the database on every
request, so a revocation takes effect on the next one (ADR-0549). The
authorization server's own session cookie works only on its own pages, where
sign-in, consent, and account changes happen.

Carry forward `src/browser-oauth.test.ts`,
`src/desktop-account-auth.test.ts`, and
`../../apps/whispering/src/lib/services/blobs/account-blob-remote.test.ts`
when changing a credential owner. After building the API UI,
`bun packages/auth/smoke/dashboard.browser.mjs` exercises the built
sign-in/callback/dashboard routes and a virtual WebAuthn authenticator while a
different principal owns the ambient browser cookie.

## Historical instance identity

Earlier installations saved a static bearer under the `instance` principal.
Current apps do not restore those credentials or old server preferences. They
leave historical local data untouched and do not assign it to a named person.
Self-hosted builds use the existing origin-derived authority bytes, so an
existing named user's local data keeps its address.
