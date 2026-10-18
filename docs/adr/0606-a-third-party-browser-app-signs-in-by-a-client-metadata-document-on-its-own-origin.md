# 0606. A third-party browser app signs in by a client metadata document on its own origin

- **Status:** Accepted
- **Date:** 2026-10-17
- **Amends:** [ADR-0578](0578-epicenter-hosts-no-mcp-server.md) at "Every OAuth client is a first-party row written by `registerFirstPartyClients`", "The authorization server composes no `@better-auth/cimd` plugin", and "A `client_id` that names a URL is an unknown client": a browser app's client id may be the URL of its client ID metadata document; the `mcp` audience stays deleted. [ADR-0589](0589-an-app-is-one-git-repository-of-built-files-at-an-address.md) at "An OAuth client id is a constant in each app's code, registered on the server": a third-party app registers nothing, and its client id is its metadata document's URL.
- **Amended by:** [ADR-0614](0614-a-browser-app-is-identified-by-its-origin.md) at the client ID metadata document, the `cimd` plugin, "A redirect URI is accepted only when the document lists it", and "Epicenter's first-party browser apps keep their rows in `BROWSER_APPS`": every browser app's client id is its origin, and nothing is registered or hosted; CORS chosen by route stands.
- **Relates:** [ADR-0605](0605-an-app-is-an-ordinary-single-page-app-in-a-forkable-git-repository.md) (every app is a static site its author deploys), [ADR-0594](0594-a-hosted-repository-is-reached-only-by-the-person-who-owns-it.md) (a token reaches every repository its owner holds).
- **Unbuilt:** all of it: the `cimd` plugin restored, the consent page for a metadata-document client, and CORS chosen by route: credentialless for the token and revocation endpoints and for bearer routes, `trustedOrigins` for cookie routes. The earlier implementation was deleted with the MCP server in commit `089cb3838f`.

## Context

Every OAuth client is a row `buildFirstPartyClients`
(`apps/api/worker/oauth-registrations.ts`) writes: six browser clients in
`BROWSER_APPS`, one of them the owner's own `com.bradenwong.zhongwen`, added
by hand. ADR-0578 removed client ID metadata documents with the MCP server
(commit `089cb3838f` deleted `client-metadata-fetch.ts` and the `cimd(...)`
wiring in `packages/server/src/auth/plugins.ts`). `corsMiddleware`
(`packages/server/src/middleware/cors.ts`) answers only `trustedOrigins`,
with `credentials: true`.

Under ADR-0605 every app is a static site its author deploys at an origin
Epicenter never sees in advance. Such an app in a browser tab has no client
id to sign in with, and its requests to the API fail CORS.

## Decision

**A third-party app in a browser tab signs in with a client ID metadata
document served from its own origin, and its client id is that document's
URL.**

```txt
https://board.alice.dev/oauth-client.json     client_id = this URL
  { "client_id": "https://board.alice.dev/oauth-client.json",
    "client_name": "Board",
    "redirect_uris": ["https://board.alice.dev/auth/callback"] }
```

- The authorization server composes `cimd(...)` from `@better-auth/cimd`
  again, fetching documents through a transport that refuses redirects and
  non-public addresses, as before commit `089cb3838f`.
- A redirect URI is accepted only when the document lists it.
- The `/consent` page asks the person every time a metadata-document client
  signs in.
- Epicenter's first-party browser apps keep their rows in `BROWSER_APPS`.

**`corsMiddleware` chooses a CORS policy by route, never by whether a
request carries `Authorization`:**

```txt
/auth/oauth2/token     any origin, no credentials   the code exchange, proven by PKCE and client_id
/auth/oauth2/revoke    any origin, no credentials   revocation, by the token and client_id
bearer routes          any origin, no credentials   every route that authenticates by bearer token
cookie routes          trustedOrigins, credentials  every route that authenticates by session cookie
```

A credentialless route sends `Access-Control-Allow-Origin` for any `Origin`
and no `Access-Control-Allow-Credentials`, so a page anywhere can call it
and none can ride a cookie. The browser already sends the token exchange
and revocation with `credentials: 'omit'` and no bearer token
(`exchange` and `revoke` in `packages/auth/src/browser-oauth.ts`), so a
policy keyed on `Authorization` would refuse both.

## Consequences

- An author publishes an app that signs in without asking Epicenter for
  anything, from any static host.
- Each sign-in from a new client costs one outbound fetch of its document,
  and an outbound fetch to a URL a stranger names is open again.
- A third-party app's token reaches every hosted repository the person owns
  (ADR-0594), so consent is the only gate on what a browser app can push.
- `corsMiddleware` becomes two policies, chosen by route path.

## Considered alternatives

- **Register each third-party app by hand, as `com.bradenwong.zhongwen` was.**
  Every new app waits on Epicenter, which is app hosting by another name.
- **Dynamic client registration.** It stores a row per registration and
  proves nothing a metadata document on the app's own origin does not.
