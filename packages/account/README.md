# @epicenter/account

Auth selects an account; every application session keeps the Account it opened with.

```ts
const auth = createBrowserOAuth({
	server: epicenterCloud('https://api.epicenter.so'),
	clientId: 'so.epicenter.vocab',
	grant: () => ({
		resources: ['https://api.epicenter.so'],
		scope: 'openid profile email ai',
	}),
	accountManagement: true,
});
const state = auth.state();
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

## An app's account

An app makes its account once, in `app.ts`, with `connectAccount`, which
picks the browser's sign-in or the shell's where the page runs
([ADR-0781](../../docs/adr/0781-apps-branch-on-what-a-capability-offers-and-one-build-serves-every-surface.md)).
The app lists nothing it uses the account for: each capability it hands the
account to says what it needs when it is made (`account.need`), and sign-in
asks for all of them
([ADR-0792](../../docs/adr/0792-an-account-asks-for-what-the-capabilities-that-take-it-need.md)).

```ts
const signIn = connectAccount({ clientId: 'so.epicenter.vocab', api: APP_URLS.API, selfHosted: SELF_HOST_ORIGIN });
export const folder = openFolder(vocab, home({ site: APPS.VOCAB.url, account: signIn })); // the folder on the server
export const ai = openAi([hosted(signIn)]); // the AI gateway
export const profile = openProfile(signIn); // the person's name and email
```

| Need | Declared by | A browser sign-in asks for |
| --- | --- | --- |
| `repository` | `home` from `@epicenter/folder` | the Git audience, `folders:read folders:write` |
| `ai` | `hosted` from `@epicenter/ai` | the API audience, `ai` |
| `profile` | `openProfile` | the API audience, `profile email` |

In a Tauri window the account is the shell's (`createTauriAuth`), which signs
in through the system browser to sync the app's folder and to use hosted
models ([ADR-0785](../../docs/adr/0785-a-desktop-app-signs-in-to-sync-its-own-folder.md)).
Nothing in an app waits on sign-in.

`PrincipalId` is the branded principal id and the partition key every server
path and R2 key derives from.
`asPrincipalId` brands a trusted `string`, and `AccountIdentity` is the
`{ authorityId, principalId }` pair without credentials. The server imports
these from the package root too.

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
`apps/api/worker/oauth-registrations.ts`. Its `grant` names its `resources`
(token audiences, from `resolveOAuthAudiences` in `@epicenter/definition/site`)
and the scopes it needs, read at each sign-in and request. Each resource gets
an access token of its own. The caller never asks for `offline_access`.

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
transcription and its folder on the server. If any token request fails, the
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

Every desktop app signs in through its own shell. The Epicenter app signs in
as `so.epicenter`, reaching every folder the person holds (`folders:all`,
ADR-0820), on the API and Git audiences; its pages ask for the Git
audience's token with `createTauriAuth({ audience: 'git' })`. Compile its
shell with `EPICENTER_SERVER_ORIGIN` for a self-hosted build; the default is
Cloud. The `epicenter` CLI is a separate program with its own sign-in
(`so.epicenter.cli`). No WebView holds a token (ADR-0549's desktop row).

A standalone desktop app (Whispering, Vocab) signs in the same way:
`createTauriAuth()` from `@epicenter/account/tauri` is an `AuthClient`
over the [`epicenter-account`](../tauri-epicenter-account/README.md) crate's
commands, which sign in as the app's native client
(`so.epicenter.<app>.native`) in the system browser, keep the refresh token
in the app's `credentials.json` in AppData
([ADR-0740](../../docs/adr/0740-every-credential-an-app-holds-lives-in-its-own-place.md)),
and relay each of the account's requests (`account_fetch`), so the page
never holds a token. Who is signed in is `account.json` in this computer's
settings (`@epicenter/local`), which only the shell writes; the client reads
it at once once the page connected (`<WhenOpen>`), so a signed-in person is
never shown signed out first. The person's provider keys are not the
account's: the shell keeps them in the same credentials file
(`connection_key_set`, `connection_key_move`) and sends a connected
endpoint's requests with them (`connection_fetch`), read through this
entry's `relayThroughShell`, the one reader of the shell's streamed answers.

```ts
import { createTauriAuth } from '@epicenter/account/tauri';
import { reactive } from '@epicenter/svelte/reactive';

export const auth = reactive(createTauriAuth());
```

## Lifetime and policy

`AuthState` is signed-out, signed-in with an Account, or reauth-required with
that same Account. An online root captures the Account once and opens its
store over it, keyed on the Account so a new one opens a new store. The
client reads `state()` and notifies through `subscribe`, the shape every
capability has
([ADR-0769](../../docs/adr/0769-svelte-reads-every-capability-through-one-reactive-copy.md)).
A Svelte app adapts it once with `reactive` from
`@epicenter/svelte/reactive` and reads `auth.state()` everywhere: component
setup or an event handler gets a snapshot, while a template, derived value,
or effect tracks changes. A component with imperative work on auth changes
can subscribe directly with `subscribe`, whose listener reads `state()`
again. `refresh()` rereads the saved OAuth cell; a focus check can await it.

```ts
const client = createBrowserOAuth(options);
export const auth = reactive(client);
```

The package has no Svelte code of its own: framework-independent packages
and CLIs use the same client and call `state()`. The callback route,
components, and app-owned services share the one adapted client, and
`isCallbackAuthClient(auth)` accepts it. Vocab's
[`auth.ts`](../../apps/vocab/src/lib/auth.ts) and Whispering's
[`#platform/auth`](../../apps/whispering/src/lib/platform/auth.ts) show the
single-export pattern.

Ordinary persistence runs during use. Browser departures remove working UI and
replace the document without awaiting application drains. Failed navigation and browser history
restoration cannot reactivate the retired working UI. Resource disposal and
acquisition rollback remain independent of navigation.

Access tokens last eight hours and are checked against the database on every
request, so a revocation takes effect on the next one (ADR-0549). The
authorization server's own session cookie works only on its own pages, where
sign-in, consent, and account changes happen.

Carry forward `src/browser-oauth.test.ts` when changing a credential owner. After building the API UI,
`bun packages/account/smoke/dashboard.browser.mjs` exercises the built
sign-in/callback/dashboard routes and a virtual WebAuthn authenticator while a
different principal owns the ambient browser cookie.

