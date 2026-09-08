# @epicenter/auth

Auth selects an account; every application session keeps the Account it opened with.

```ts
const auth = createHostedBrowserRedirectAuth({
 appId: 'so.epicenter.example',
 baseURL: 'https://api.epicenter.so',
});
const state = auth.state;
if (state.status !== 'signed-out') {
 const account = state.account;
 const session = epicenter.open(account);
 // Session-owned services use account.fetch, too.
 // The component that opened the session closes it on unmount.
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

## One hosted session path

Better Auth owns sessions and remains the client of social identity providers.
Epicenter does not issue OAuth access/refresh grants. `createSessionAuth`
owns one persisted `{ token, principalId }` cell, verification, ordered writes,
sign-in cancellation, and Account retirement.

The cached principal permits local boot without a network call. Before the
first resource request, the runtime verifies that the credential belongs to
that principal through `/api/session`. A rejected credential preserves the
Account and publishes `reauth-required`; an unavailable server refuses network
traffic without discarding local identity.

Requests use an explicit signed session bearer with `credentials: 'omit'`.
The Account rejects foreign origins and does not follow redirects. A 401
pauses that credential. A request retries once only if same-Account
reauthentication installed a different credential while it was in flight.
There is no refresh-token exchange.

## Browser and dashboard

`createHostedBrowserRedirectAuth` composes local credential storage,
sessionStorage handoff transactions, and `createSessionAuth`. Browser apps
and the hosted dashboard use this same composition. The dashboard uses
`/session/callback`; app callbacks default to `/auth/callback`.

`startSignIn` begins a hosted sign-in. The hosted page explicitly continues
with its cookie session, or completes a social/passkey sign-in. The callback
carries only a short-lived code and state. The client redeems it with its PKCE
verifier for an independent signed session. Cancelled, superseded, and replayed
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
and completes the hosted handoff through the native deep link.

The host forwards HTTP and live sync through its captured boot Account while a
new sign-in is persisted for relaunch. A failed relaunch cannot make an old
window use a replacement Account. Apps own their local stores and sync engines;
the host relays bytes and owns no application replica or reconnect loop.

## Lifetime and policy

`AuthState` is signed-out, signed-in with an Account, or reauth-required with
that same Account. Svelte apps adapt it with `fromAuth` and key the session
component on `auth.state.account`, never principal or status alone.

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

## Instance credentials

`createInstanceAuth` accepts a fixed `baseURL`, persisted auth storage, and
`requestToken({ signal })`. The caller collects the existing operator token;
the shared owner verifies `/api/session` before saving identity or publishing
an Account. Previously verified identity can reopen offline, but network use
must pass verification. The same Account lifetime, HTTP, and socket rules apply.

Instance disconnect clears local persistence and retires the Account without
calling hosted revocation endpoints. The token has no expiration; the operator
rotates the configured server token to invalidate it. This constructor replaces
the unused instance credential authority. Client server selection and token-entry
UI are not yet wired into the shipped applications.
