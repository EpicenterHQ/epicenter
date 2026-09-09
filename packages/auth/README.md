# @epicenter/auth

Auth selects an account; every application session keeps the Account it opened with.

```ts
const startup = createBrowserAuth({
 appId: 'so.epicenter.example',
 baseURL: 'https://api.epicenter.so',
});
const state = startup.auth?.state;
if (state && state.status !== 'signed-out') {
 const account = state.account;
 // Keep this Account for the lifetime of the opened application.
 const response = await account.fetch('/api/session');
}
```

`Account` holds a fixed `principalId` and `baseURL`, authenticated `fetch`,
`openWebSocket`, and `getProfile`. Its object identity lasts through temporary
disconnection and uninterrupted same-person reauthentication. Browser
navigation or desktop host relaunch creates a new runtime and application session.

Sign-out or account replacement permanently retires its network access.
Signing back in creates a new Account, even for the same person on the same
server. Retirement aborts HTTP requests and response streams, closes sockets,
and prevents pending authorization or retries from borrowing a successor
credential. It cannot undo an operation the server already processed.

Hosted sign-out clears persistence and waits up to five seconds for a best-effort
server revocation attempt. Failure or timeout is logged, not returned as proof
of remote logout. Success confirms local cleanup, not remote revocation.
Replacing a credential also awaits bounded cleanup of its predecessor before
sign-in completes, without delaying local retirement or blocking storage writes.

## One session lifetime

Better Auth owns Cloud sessions and social-provider sign-in. The self-hosted
credential owner stores admitted people, passkeys, and opaque sessions.
Epicenter does not issue OAuth access/refresh grants. `createSessionAuth`
owns one persisted `{ token, principalId }` cell, verification, ordered writes,
sign-in cancellation, and Account retirement. Its constructor requires the
`authorityId` selected by trusted installation composition. Matching principal
IDs on two servers must receive different authorities.

`SessionAuthClient` exposes sign-in; `CallbackAuthClient` adds callback
completion. Neither implies Cloud identity or dashboard support. Cloud browser
and desktop composition pass the existing `epicenter-api` authority and attach
`createAccountManagementUrl` themselves. The session owner does not assign
Cloud policy to another issuer. Self-hosted composition derives its authority
from the selected server origin and exposes passkey sign-in without Cloud
management links.

The cached principal permits local boot without a network call. Before the
first resource request, the runtime verifies that the credential belongs to
that principal through `/api/session`. A rejected credential preserves the
Account and publishes `reauth-required`; an unavailable server refuses network
traffic without discarding local identity.

Requests use an explicit session bearer with `credentials: 'omit'`.
The Account rejects foreign origins and does not follow redirects. A 401
pauses that credential. A request retries once only if same-Account
reauthentication installed a different credential while it was in flight.
There is no refresh-token exchange.

## Browser and dashboard

`createBrowserAuth` reads the server selected for this document. Its startup
object exposes `auth`, `connectInstance({ url })`, and `useCloud()`. A new server
selection retires the current Account and takes effect in a fresh document.
Application code closes its producers and App before invoking that change.
Entering the configured Cloud origin as a custom server is refused so one
server cannot acquire two local authority identities.

`createBrowserRedirectAuth` owns browser storage, callback validation, and
navigation for both issuers. `createHostedBrowserRedirectAuth` adds Cloud's
identity, management links, and exact ceremony-cookie policy. The dashboard
uses that Cloud composition with `/session/callback`; app callbacks default
to `/auth/callback`.

`startSignIn` opens the selected issuer’s sign-in page. The hosted page explicitly continues
with its cookie session, or completes a social/passkey sign-in. The callback
carries only a short-lived code and state. The client redeems it with its PKCE
verifier for an independent session. Cancelled, superseded, and replayed
completions cannot install a credential; orphaned results are revoked where possible.
A passive handoff inherits the source session's authentication age.

Only callback-capable clients expose `completeSignIn`. Success means the
credential was verified, persisted, and published. The callback route then uses
`window.location.replace` to leave the callback document.
`startSignIn({ reauthenticate: true })` requests a new sign-in instead of
reusing the hosted cookie through the Continue button.

The dashboard captures an Account for its requests and query cache. Its
Better Auth management client also uses that Account and sends the expected
principal. Ambient cookies belong to hosted sign-in, not dashboard resources.

The browser adapter permits challenge/state cookies only on same-origin
`/auth/link-social`, `/auth/passkey/generate-register-options`, and
`/auth/passkey/verify-registration` requests carrying the captured bearer and
expected principal. Their server guard resolves that bearer before reading
ambient cookies. This preserves browser ceremonies without cookie fallback.

## Desktop

Desktop WebViews use `createDesktopBrokerAuth`; they receive identity and
loopback access, never the remote credential. Bun owns the same session runtime
and completes the selected issuer’s handoff through the native deep link.

The host forwards HTTP and live sync through its captured boot Account.
A first sign-in or different-person replacement is persisted for relaunch.
Same-person repair keeps that Account and resumes application launching. The
native close barrier has already closed app windows; resuming permits new
windows and does not restore those that closed. A failed relaunch cannot make an old
window use a replacement Account. Apps own their local stores and sync engines;
the host relays bytes and owns no application replica or reconnect loop.

## Lifetime and policy

`AuthState` is signed-out, signed-in with an Account, or reauth-required with
that same Account. Store apps capture the Account from the plain client in
application bootstrap and keep one App per document. Svelte adapts auth with
`fromAuth` only for UI tracking. Deliberate departure closes the App before
mutating identity and navigating; unexpected retirement never opens a successor
in the same document. Desktop children await the host close barrier before
voluntary retirement.

The hosted server checks live session rows on HTTP requests and socket admission.
Sessions last 30 days and renew after one day of use. Renewal does not reset
authentication age. Sensitive account changes require a matching principal and
a session younger than 600 seconds. A completed social sign-in can satisfy that
window through provider SSO; it is not proof of fresh human interaction.

Admitted store sockets have a server-enforced 600-second authorization deadline,
including idle and hibernating connections. Revocation rejects subsequent
admission; it does not immediately close every existing socket.

Carry forward `src/account-lifetime.test.ts`,
`src/desktop-broker-auth.test.ts`,
`../../apps/epicenter/src/account-transport.test.ts`, and
`../../apps/whispering/src/lib/services/blobs/account-blob-remote.test.ts`
when changing the credential owner. The opt-in
`bun packages/auth/smoke/session-handoff.browser.mjs` exercises Chromium with
disposable hosted-login fixtures, not real provider credentials or packaged Tauri.
After building the API UI, `bun packages/auth/smoke/dashboard.browser.mjs`
exercises the built sign-in/callback/dashboard routes and a virtual WebAuthn
authenticator while a different principal owns the ambient browser cookie.

## Historical instance identity

Earlier installations saved a static bearer under the `instance` principal.
The startup readers keep those credentials and local addresses separate from
named-user sessions. `createInstanceAuth` restores that historical attachment;
it does not offer sign-in or borrow a named user’s credential. The current
self-host entries no longer authorize the old static bearer.

Connection screens accept a server URL and start issuer sign-in. There is no
new static-token connection path. Selecting the issuer from an old installation
ends the old attachment and opens sign-in in a new document or process. It does
not assign historical library content to the newly signed-in person.
