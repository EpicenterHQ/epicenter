# @epicenter/auth

Auth selects an account; every data session keeps the account it opened with.

```ts
const auth = createHostedBrowserRedirectAuth(/* browser configuration */);
const state = auth.state;
if (state.status !== 'signed-out') {
 const account = state.account;
 const session = epicenter.open(account);
 // Session-owned services use account.fetch, too.
 // The component that opened the session closes it on unmount.
}
```

`Account` holds a fixed `principalId` and `baseURL`, authenticated `fetch`,
`openWebSocket`, and `getProfile`. Within a running auth authority, its object
identity lasts through credential refresh, temporary disconnection, and
reauthentication as the same person. A browser navigation or desktop host
relaunch creates a new authority and application session.
Sign-out or account replacement permanently retires its network access. Signing
back in creates a new Account, even for the same person on the same server.

An account accepts requests only for its own server. Retirement aborts in-flight
HTTP requests and response streams, closes its sockets, and prevents pending
authorization or retries from using a successor account. It cannot undo an
operation the server already processed. A request's own cancellation does not
cancel another request's shared credential refresh.

`AuthState` is signed-out, signed-in with an Account, or reauth-required with
that same Account. The status belongs to auth; it is not part of the account's
identity. Svelte apps use `fromAuth` and key the session component on
`auth.state.account`.

## Browser and desktop

Browser OAuth accounts attach a bearer directly. Desktop accounts send HTTP and
live sync through the loopback Bun host. The host captures its boot account and
forwards through that account even while a new sign-in is being persisted for
relaunch. A failed relaunch therefore cannot make an old window use a new
account. Server credentials never cross into the window.

Apps own their local stores and sync engines in both environments. Closing a
data session stops its sync connection. The host relays bytes and owns no app
replica, reconnect loop, or background synchronization.

`AuthIdentityState` is the serializable identity projection used by credential
authorities and the desktop bootstrap. It contains no transport functions.

## Account UI and the cookie dashboard

Shared sign-in and profile UI takes `AuthControls`. Data apps use the narrower
`AuthClient`, whose selected state includes a real Account. Only callback-capable
OAuth clients expose `completeSignIn`.

The same-origin dashboard uses its concrete cookie HTTP client. Its ambient
cookie cannot promise account-bound replica traffic, so it exposes no Account
and no sync socket stub. Third-party inference uses its own transport and key.

## Changing the credential model

Credential issuance, renewal, and persistence can change underneath Account.
Keep its lifetime independent of the token format, and preserve the desktop
host's captured boot account even when relaunch fails. The current OAuth
implementation is one provider of that contract.

Carry forward the behavior covered by `src/account-lifetime.test.ts`,
`src/desktop-broker-auth.test.ts`,
`../../apps/epicenter/src/account-transport.test.ts`, and
`../../apps/whispering/src/lib/services/blobs/account-blob-remote.test.ts`.
Replace credential-specific fixtures as needed while retaining the retirement,
request replay, streaming cancellation, and socket closure checks. Navigation
and host relaunch recreate the runtime; same-runtime renewal does not.
