# 0950. `api.epicenter.so` is a model API, and every client reaches it with an API key

- **Status:** Proposed
- **Date:** 2026-11-17
- **Supersedes:** [ADR-0549](0549-every-epicenter-resource-accepts-only-opaque-access-tokens-from-one-oauth-authorization-server.md) (every resource accepts only opaque access tokens from one OAuth 2.1 authorization server) and [ADR-0331](0331-whispering-authenticates-with-an-oauth-bearer-on-every-surface.md) (Whispering authenticates with an OAuth bearer on every surface).
- **Amends:** [ADR-0634](0634-hosted-inference-is-independent-of-repository-sync.md) at "retain the existing ... `ai` authorization scope": an API key, not a scope on an OAuth token, authorizes hosted inference.
- **Relates:** [ADR-0894](0894-whispering-8-keeps-its-recordings-and-their-audio-in-its-own-data-directory-and-needs-no-epicenter.md) (Whispering keeps its recordings itself and connects to paid models), [ADR-0951](0951-ai-credits-follow-what-a-call-uses-held-before-it-and-settled-after.md) (credits follow what a call uses; ships with this record), [ADR-0899](0899-the-folder-sync-product-is-retired.md) (the folder sync product is retired), [ADR-0060](0060-an-inference-connection-is-a-base-url-and-an-optional-bearer-key.md) (a connection is a base URL and an optional bearer key), [ADR-0948](0948-a-value-several-apps-share-goes-in-the-homes-env-which-only-env-reads.md) (a home keeps a pasted credential in `.env`), [ADR-0578](0578-epicenter-hosts-no-mcp-server.md) (Epicenter hosts no MCP server), [ADR-0943](0943-epicenters-core-invariants.md) (what a simplification removes, and who accepts it).
- **Unbuilt:** all of it, beside ADR-0951. The first thing to exist is `apiKey()` from `@better-auth/api-key` in the hosted API's Better Auth plugins and the `/connect` handoff.

## Context

The hosted API (`apps/api` and `packages/server`, a Cloudflare Worker)
grew to serve the folder sync product and every app that signed in to it:
Todos, Capture, Vocab, Zhongwen, the Epicenter desktop app
(`so.epicenter`), and the CLI (`so.epicenter.cli`, by device grant). The
folder sync product is retired (ADR-0899), and Whispering 8 keeps its
recordings on its own device (ADR-0894). Whispering is the one product
left that calls the hosted API, for paid models through an
OpenAI-compatible gateway (`/v1/chat/completions`,
`/v1/audio/transcriptions`). No account holds data in a hosted folder (the
owner, 2026-11-17).

Whispering reaches the gateway with OAuth 2.1 (ADR-0549):
`@better-auth/oauth-provider` (`packages/server/src/auth/plugins.ts`,
`oauth-policy.ts`, `resource-access.ts`, `offline-detach.ts`), client rows
in `apps/api/worker/oauth-registrations.ts`, a browser client
(`packages/account/src/browser-oauth.ts`, 746 lines), a desktop client
(`packages/tauri-epicenter-account/src/account.rs`, 1,494 lines), and an
account relay (`packages/account/src/relay.ts`). Part of that size serves
retired needs, several audiences and folder scopes. What remains in any
OAuth client is rotation: a single refresh in flight, renewal timers, and
a reuse window. ADR-0549 records a duplicate refresh that signed a person
out of every device.

An OAuth access token works only in a client that runs the flow. A person
cannot paste one into another OpenAI tool or into a home's `.env`
(ADR-0948). The reasons ADR-0549 gave for one authorization server,
third-party MCP clients and Git credentials for hosted folders, went with
ADR-0578 and ADR-0899. Its own history records the hosted API moving from
OAuth to sessions and back to OAuth.

Better Auth 1.8 has an API key plugin, `@better-auth/api-key`
(`1.8.0-beta.7`, peer `better-auth ^1.8.0-beta.7`): hashed keys, a prefix,
creating a key for a user on the server, verifying one, and listing and
revoking them. Nothing in Better Auth issues a key at the end of a consent
or PKCE flow. The deleted `session-handoff.ts` (last present at
`7a62f07a4b^:packages/server/src/auth/session-handoff.ts`) issued a session
through a 120-second single-use code bound to S256 PKCE and an exact
callback.

## Decision

**`api.epicenter.so` is an OpenAI-compatible model API with a dashboard.
Every client reaches it with an Epicenter API key: a bearer that belongs
to one account and is made for one device or tool. Whispering gets one
with a Connect button; anything else gets one from the dashboard.**

| Keeps | Loses |
| --- | --- |
| Sign-in to the website with Google, GitHub, Microsoft, Apple, and passkeys, as a Better Auth cookie session | The OAuth server: `oauthProvider`, its tables, audiences, scopes, client rows, and the consent page |
| `/v1/chat/completions` and `/v1/audio/transcriptions` | Device sign-in: `/device` and the device code grant |
| API keys, and the Connect handoff that makes one for an app | The OAuth clients of Todos, Capture, Vocab, Zhongwen, the Epicenter desktop app, the CLI, and Whispering |
| `/v1/models`, `/v1/credits`, and `/v1/key` | `/folders`, the `folders` audience, the R2 binding, and the `storage_bytes` meter |
| The dashboard: account, keys, usage, credits, and buying more | `/api/session` |
| The Cloudflare Worker | The Bun server (`apps/api/server.ts`) |

- **A key is Better Auth's API key plugin.** `apiKey()` with the prefix
  `ep_`, a getter that reads `Authorization: Bearer`, the plugin's own rate
  limit off, and its usage writes deferred to `waitUntil`. A key has no
  session (`enableSessionForAPIKeys` stays off), so it reaches the model
  API and never account management. A key made for a browser expires after
  90 days; any other key lasts until it is revoked.
- **Connect makes a key for one device in one click.** The app opens
  `/connect` with a callback and an S256 PKCE challenge. The person signs
  in to the website if they are not already, and approves "Connect
  Whispering on this Mac". The server keeps a 120-second single-use code in
  Better Auth's `verification` table and returns to the callback with it.
  The app sends the code and its verifier; the server creates the key with
  the device's name and returns it once. A callback is accepted only on
  loopback (`http://127.0.0.1:<port>`) or at Whispering's web origin, so no
  other site can ask for a key. The handoff is one small plugin modelled on
  the deleted `session-handoff.ts`.
- **The two builds differ only in how the code comes back and where the key
  is kept.** The desktop opens the system browser and receives the code
  through `tauri-plugin-oauth`, which listens on a loopback port from
  JavaScript; Whispering adds no Rust for it. The web build opens
  `/connect` in a popup, which posts the code to its opener after checking
  the opener's origin, so the page never reloads and a recording is not
  interrupted. Exchanging the code is the same code in both. The key is a
  Keychain item on the desktop and in `localStorage` in a browser
  (ADR-0894).
- **Epicenter is one more connection.** To Whispering, and to any OpenAI
  tool, it is a base URL, `https://api.epicenter.so/v1`, and a key
  (ADR-0060). A home that wants Epicenter's models puts a key in its `.env`
  (ADR-0948), as any tool would; the hosted API does not know it is a home.
- **The model API speaks OpenAI's shape, so any OpenAI client works:**
  - Model ids name their vendor: `openai/gpt-5.5`, `google/gemini-3.5-flash`,
    `openai/whisper-1`.
  - `GET /v1/models` answers OpenAI's list, with each model's `name`,
    capabilities, and price (ADR-0951) beside it.
  - `GET /v1/credits` answers the balance, what the plan grants, when it
    renews, and the dashboard's billing page. `GET /v1/key` answers the
    key's name and its account's email, for "Connected as". `DELETE /v1/key`
    revokes the key that sends it.
  - A failure answers OpenAI's envelope, `{ error: { message, type, code } }`:
    401 `invalid_api_key`, 404 `model_not_found`, and 402
    `insufficient_credits` with a `top_up_url`. Running out is 402, not
    OpenAI's 429, because OpenAI clients retry a 429.
  - `/v1` answers any origin, with a bearer and no cookie.
- **The dashboard is the website's own session.** It lists, names, creates,
  and revokes keys through the plugin's endpoints, shows usage per key, and
  buys credits. Revoking a lost device's key ends its access at once.
- **It ships with ADR-0951.** A key works in any OpenAI tool, so a call is
  charged for what it uses before keys are offered.
- Dropping the tables of what this removes is a separate operation the
  owner approves; the change that removes the routes leaves production data
  alone.

## Consequences

- One credential reaches the hosted API, and Whispering holds it like any
  provider's key. A later hosted service, such as Git LFS storage for a
  home or shared Whispering text, can take the same key, with a scope on it
  when a second service needs one.
- **Code removed:** `oauthProvider` and `oauthDeviceAuthorization` in
  `packages/server/src/auth/plugins.ts`; `oauth-policy.ts`,
  `offline-detach.ts`, `resource-access.ts`, and both
  `oauth-registrations.ts`; the consent and device pages;
  `packages/account/src/browser-oauth.ts`, `tauri.ts`, and `relay.ts`; and
  `packages/tauri-epicenter-account`. `@epicenter/account` keeps the
  dashboard's cookie session alone. `hosted()` in `@epicenter/ai` becomes
  a preset connection.
- **Code added,** roughly 400 to 500 lines: the handoff plugin, the key
  check on `/v1`, the `/connect` page, Whispering's Connect, the three
  `/v1` routes, and the dashboard's key list.
- A key's verification writes its usage through `waitUntil`, which needs
  Better Auth's background task handler; the API configures none today.
- To test before it is built: a key with no expiry, the bearer getter, and
  the plugin's rate limit turned off, on `1.8.0-beta.7`.
- **What this removes, and who accepts it** (ADR-0943):

  | Removed | Who loses what | Who takes on the work |
  | --- | --- | --- |
  | Refreshing access tokens | A stolen key works until it is revoked or, in a browser, until its 90 days end, where a stolen access token lasted 8 hours | The person, who revokes a key from the dashboard; the dashboard shows each key's last use |
  | Signing in inside the app | Whispering shows "Connected as" from the key, and has no account screen of its own | The person, who manages the account on the website |
  | Device sign-in | A CLI cannot sign in by code | The person, who pastes a key |
  | Other apps' OAuth clients | Nothing; those apps no longer sign in | None |
  | The Bun server | Running the API outside Cloudflare | The owner, who runs the Worker locally with Wrangler |
  | `/folders` and its storage | Nothing; no account holds data there | The owner, who approves deleting the empty tables |

## Considered alternatives

- **Keep OAuth as built.** Rotation, timers, and a reuse window in every
  client, and a token no other tool can use.
- **Keep OAuth with a minimal client** (`oauth4webapi`, already in the
  catalog). Smaller clients, the same rotation, and still a second
  credential beside keys for other tools and a home.
- **OAuth for Whispering and keys for everything else.** Two ways to reach
  one API, kept forever.
- **Paste a key, with no Connect.** Every Whispering user would visit the
  dashboard and copy a secret.
- **An open callback, as OpenRouter's `callback_url` is.** Any site could
  ask a signed-in person for a key.
- **Better Auth's device authorization or one-time token.** Each issues a
  session, not a key; the one-time token binds no PKCE.
- **A session for each key (`enableSessionForAPIKeys`).** A leaked key would
  reach account management.
- **A deep link for the desktop's callback.** It needs the scheme registered
  with each platform; a loopback port needs nothing.
- **Keep the Bun server for self-hosting.** A second runtime for the one
  deployment that runs.
