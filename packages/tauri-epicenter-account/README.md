# Sign-in and credentials for desktop apps

`epicenter-account` is the Rust every desktop app shares to sign in with
Epicenter and to keep the app's secrets. A standalone app
(`epicenter-standalone`) keeps its data as files in a folder Epicenter syncs,
so it signs in only for hosted capabilities: inference and transcription on
Epicenter's API. The Epicenter app signs in as `so.epicenter` for every
folder the person holds too (`AccountApp::EVERY_FOLDER`, `folders:all`), on
the API and folders audiences (`AccountApp::API_AND_FOLDERS`). The page's side is `createTauriAuth` from
`@epicenter/account/tauri`; the page's side of the provider keys and the
requests sent with them is `@epicenter/ai/tauri`.

## Signing in

The native-app flow (RFC 8252): `account_sign_in` opens the authorization
page in the system browser and listens once on
`http://127.0.0.1:<port>/callback` for the code, with S256 PKCE and a
`state` that a stale tab cannot match. An embedded page is never used
(Google refuses it). The code becomes a refresh token, kept in the
credentials file under `account:<origin>`, and an access token per audience
the app signs in for (the code is exchanged for the first; the refresh token
mints each other when a request first needs it), kept in this process's
memory and renewed five minutes before it expires. A refresh token the server
rotates replaces the stored one before it is used again, and quitting waits
up to ten seconds for a refresh in flight to store it (the plugin's `Exit`
hook), so a quit never spends the stored token without keeping its successor. `account_sign_out` forgets the sign-in and asks the server to
revoke it, waiting at most five seconds.

Each app is its own native client, `so.epicenter.<app>.native` (decision 84),
named once in its `main.rs`:

```rust
const ACCOUNT: AccountApp = AccountApp {
    client_id: "so.epicenter.vocab.native",
    name: "Vocab",
    scope: AccountApp::HOSTED_MODELS,
    audiences: AccountApp::API,
    relays: Relays::Inference,
};
```

`relays` is what the app's windows may send on the account (below): a
standalone app's is `Relays::Inference`, and the Epicenter app's is
`Relays::AnyRoute`.

The deployment registers the same id in
`apps/api/worker/oauth-registrations.ts` (`NATIVE_APPS`), with every redirect
kind the app uses; the loopback redirect matches on any port. A debug build
signs in against `EPICENTER_API_URL` when set (a local API), otherwise
`https://api.epicenter.so`.

## Who is signed in

Who is signed in is a setting only the shell writes: `account.json` at the
top of the app's AppData directory.

```json
{ "origin": "https://api.epicenter.so", "principalId": "<id>", "refused": false }
```

`principalId` is `null` when no one is signed in, and `refused` is `true`
once the server refused the refresh token (`invalid_grant`), when only a new
sign-in helps. The shell writes the file whole (staged beside it, then
renamed over it) at startup, once it read the grant from the credentials
file, and again on a sign-in, a sign-out, and a refused refresh. The page
reads it like any other setting in the AppData root, and the folder plugin's
watch of that root tells every window when it changes.

## The page never holds a token

The API trusts no `tauri://localhost` origin, and the token stays in Rust:
the page sends each of the account's requests through `account_fetch`, which
adds the bearer token of the audience the request names (`audience: "folders"`,
or the API's when it names none), sends it only to the deployment's origin,
where both audiences are, renews a
token the server rejects once, and streams the answer back on a channel (its
head, the body's raw chunks, then its end or an error). `account_fetch_cancel`
stops one. A request with no token to send ends with `reauth-required` or
`auth-unavailable`, which the page's client turns into its auth state.

A standalone app signs in only for hosted features (ADR-0822), so its
windows send only hosted inference on the account: `INFERENCE_ROUTES` in
`src/account.rs`, matched on the method and the exact path on the
deployment's origin.

| Method | Path | |
| --- | --- | --- |
| `POST` | `/v1/chat/completions` | hosted chat models |
| `POST` | `/v1/audio/transcriptions` | hosted transcription |

`account_fetch` refuses any other request, before it reads a token or
sends anything, with `<App> sends only Epicenter's hosted inference on its
account, not <method> <url>`. The Epicenter app, the one desktop program
that syncs, relays any request to its audiences' origins: who is signed in,
the folders, and their history. `fixtures/relayed-routes.json` lists the
same routes; the crate's tests hold the table equal to it, and `apps/api`'s
`runtime-profile.test.ts` checks that both API entries serve each one and
that each is an inference gateway.

## A connected endpoint's requests

An app whose person connects their own OpenAI-compatible endpoints (Vocab,
Whispering) saves each one's key with
`connection_key_set({ id, endpoint, key })`, which writes `key:<id>` as
`{ "endpoint": …, "key": … }` in the credentials file, or removes it for a
`null` key. The page never reads a key back. When a connection's endpoint
changes, `connection_key_move({ id, from, to })` points its key at `to`, only
when the key was saved for `from`. An id is letters, digits, `_` and `-`, at
most 64 of them, so a page can never name the account's entry.

The page sends the endpoint's requests through `connection_fetch` rather
than its own `fetch`, which CORS holds to endpoints that answer a `tauri://`
page. The page names the connection and describes the request (URL, method,
headers, base64 body); the shell reads `key:<id>` from the credentials file
for that request, refuses a URL whose origin is not the saved endpoint's (so
a hand-edited connection list cannot move the key), refuses a credential
header from the page, adds `Authorization: Bearer <key>` itself, and sends
only `https`, or `http` to `localhost` or `127.0.0.1`. A connection with no
saved key is sent with none, and so is a request that names no connection
(`shellFetch` from `@epicenter/ai/tauri`), which is how the page reaches
Ollama or LM Studio on this computer. A redirect is not followed. The answer
streams back on a channel exactly as `account_fetch`'s does (`relay.rs`), so
a token stream reads as it arrives, except that a refusal sent with a key is
read whole and sent with the key removed wherever its body repeats it;
`connection_fetch_cancel` stops one. A refusal is a `ConnectionFetchError`
(`InvalidRequest`, `SchemeRefused`, `OriginRefused`, `CredentialsFailed`,
`SendFailed`), named in `name`; the page's side is `connectionFetch(id)` from
`@epicenter/ai/tauri`.

## The credentials file

Every secret an app holds is in one file, `credentials.json` at the top of
its AppData directory (ADR-0740): JSON `{ name: value }`, with the refresh
token under `account:<origin>` and each connection's key under
`key:<connection id>`. It is the person's alone (mode `0600` on unix), and
every write stages the whole file beside it and renames it over the old one.
The shell reads it whenever a request needs a secret; only the access token
lives in memory. The folder plugin leaves it out of the AppData root's
listing and refuses a page's read or write of it. A `.dev` build has its own
AppData, so it never reads a release build's credentials. A debug build
started with `EPICENTER_SECRETS_FILE=<path>` keeps its credentials in that
file instead, so tests and smoke runs never touch the person's.

The path is known only once the app runs, so `manage` installs a small
plugin whose setup places the credentials file and `account.json` in
Tauri's `app_data_dir()`, the directory the folder plugin names
`Root::AppData`, then writes `account.json`.

## Wiring an app

```rust
epicenter_account::manage(builder, ACCOUNT)
    .invoke_handler(tauri::generate_handler![
        epicenter_account::account::account_sign_in,
        epicenter_account::account::account_sign_out,
        epicenter_account::account::account_fetch,
        epicenter_account::account::account_fetch_cancel,
        // An app that reaches endpoints other than Epicenter's adds
        // `CONNECTION_COMMANDS`:
        epicenter_account::connection::connection_key_set,
        epicenter_account::connection::connection_key_move,
        epicenter_account::connection::connection_fetch,
        epicenter_account::connection::connection_fetch_cancel,
    ])
```

The app's `build.rs` declares those commands (`COMMANDS`, and
`CONNECTION_COMMANDS` when it registers them) with
`tauri_build::AppManifest::new().commands(…)`, and its capability grants
`allow-<command>` for each. The page:

```ts
import { createTauriAuth } from '@epicenter/account/tauri';
import { reactive } from '@epicenter/svelte/reactive';

export const auth = reactive(createTauriAuth());
```

`cargo test -p epicenter-account`, which runs a streamed answer from a local
server; the page's client is tested in `packages/account/src/tauri.test.ts`.
