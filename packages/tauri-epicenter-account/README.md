# Sign-in and the keychain for standalone desktop apps

`epicenter-account` is the Rust every standalone desktop app shares to sign
in with Epicenter and to keep secrets in the OS keychain. A standalone app
(`epicenter-standalone`) keeps its data as files in a folder Epicenter syncs,
so it signs in only for hosted capabilities: inference and transcription on
Epicenter's API. The page's side is `createTauriAuth` from
`@epicenter/auth/tauri`.

## Signing in

The native-app flow (RFC 8252): `account_sign_in` opens the authorization
page in the system browser and listens once on
`http://127.0.0.1:<port>/callback` for the code, with S256 PKCE and a
`state` that a stale tab cannot match. An embedded page is never used
(Google refuses it). The code becomes a refresh token, kept in the keychain
under `account:<origin>`, and an access token for the API audience, kept in
this process's memory and renewed five minutes before it expires. A refresh
token the server rotates replaces the stored one before it is used again; one
the server refuses (`invalid_grant`) makes the state `reauth-required`.
`account_sign_out` forgets the sign-in and asks the server to revoke it,
waiting at most five seconds.

Each app is its own native client, `so.epicenter.<app>.native` (decision 84),
named once in its `main.rs`:

```rust
const ACCOUNT: AccountApp = AccountApp {
    client_id: "so.epicenter.vocab.native",
    name: "Vocab",
    scope: AccountApp::HOSTED_MODELS,
};
```

The deployment registers the same id in
`apps/api/worker/oauth-registrations.ts` (`NATIVE_APPS`), with every redirect
kind the app uses; the loopback redirect matches on any port. A debug build
signs in against `EPICENTER_API_URL` when set (a local API), otherwise
`https://api.epicenter.so`.

## The page never holds a token

The API trusts no `tauri://localhost` origin, and the token stays in Rust:
the page sends each of the account's requests through `account_fetch`, which
adds the bearer token, sends it only to the deployment's origin, renews a
token the server rejects once, and streams the answer back on a channel (its
head, the body's raw chunks, then its end or an error). `account_fetch_cancel`
stops one. A request with no token to send ends with `reauth-required` or
`auth-unavailable`, which the page's client turns into its auth state.

## A connected endpoint's requests

An app whose person connects their own OpenAI-compatible endpoints (Vocab)
saves each one's key with `keychain_set(<connection id>, '{"endpoint": …,
"key": …}')`, and sends the endpoint's requests through `connection_fetch`
rather than the page's `fetch`, which CORS holds to endpoints that answer a
`tauri://` page. The page names the connection and describes the request
(URL, method, headers, base64 body); the shell reads `key:<id>`, refuses a
URL whose origin is not the saved endpoint's (so a hand-edited connection
list cannot move the key), refuses a credential header from the page, adds
`Authorization: Bearer <key>` itself, and sends only `https`, or `http` to
`localhost` or `127.0.0.1`. A connection with no saved key is sent with none.
A redirect is not followed. The answer streams back on a channel exactly as
`account_fetch`'s does (`relay.rs`), so a token stream reads as it arrives;
`connection_fetch_cancel` stops one. A refusal is a `ConnectionFetchError`
(`InvalidRequest`, `SchemeRefused`, `OriginRefused`, `KeychainFailed`,
`SendFailed`), named in `name`; the page's side is `connectionFetch(id)` from
`@epicenter/auth/tauri`.

## The keychain

`keychain` is the one way an app reaches the keychain: the refresh token
above, and the API keys a page saves under names of its own
(`keychain_get(names)`, `keychain_set(name, value)`), filed as `key:<name>`.
A name is letters, digits, `_` and `-`, so a page can never name the
account's entry. Entries are filed under the bundle identifier, so a `.dev`
build never reads a release build's. A debug build started with
`EPICENTER_SECRETS_FILE=<path>` keeps everything in that JSON file instead,
so tests and smoke runs never touch the person's keychain.

## Wiring an app

```rust
let context = tauri::generate_context!();
epicenter_account::manage(builder, ACCOUNT, &context.config().identifier)
    .invoke_handler(tauri::generate_handler![
        epicenter_account::account::account_state,
        epicenter_account::account::account_sign_in,
        epicenter_account::account::account_sign_out,
        epicenter_account::account::account_fetch,
        epicenter_account::account::account_fetch_cancel,
        epicenter_account::keychain::keychain_get,
        epicenter_account::keychain::keychain_set,
        // An app that connects endpoints adds `CONNECTION_COMMANDS`:
        epicenter_account::connection::connection_fetch,
        epicenter_account::connection::connection_fetch_cancel,
    ])
```

The app's `build.rs` declares those commands (`COMMANDS`, and
`CONNECTION_COMMANDS` when it registers them) with
`tauri_build::AppManifest::new().commands(…)`, and its capability grants
`allow-<command>` for each. The page:

```ts
import { createTauriAuth, keychain } from '@epicenter/auth/tauri';
import { fromAuth } from '@epicenter/auth/svelte';

const { client, ready } = createTauriAuth();
export const auth = fromAuth(client);
```

`cargo test -p epicenter-account`, which runs a streamed answer from a local
server; the page's client is tested in `packages/auth/src/tauri.test.ts`.
