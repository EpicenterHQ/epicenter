# 0606. Browser sign-in uses the calling origin

- **Status:** Accepted
- **Date:** 2026-10-17
- **Amends:** [ADR-0578](0578-epicenter-hosts-no-mcp-server.md) at "Every OAuth client is a first-party row written by `registerFirstPartyClients`", "The authorization server composes no `@better-auth/cimd` plugin", and "A `client_id` that names a URL is an unknown client": a browser app's client id may be the URL of its client ID metadata document; the `mcp` audience stays deleted. [ADR-0589](0589-an-app-is-one-git-repository-of-built-files-at-an-address.md) at "An OAuth client id is a constant in each app's code, registered on the server": a third-party app registers nothing, and its client id is its metadata document's URL.
- **Amended by:** [ADR-0614](0614-a-browser-app-is-identified-by-its-origin.md) at the client ID metadata document, the `cimd` plugin, "A redirect URI is accepted only when the document lists it", and "Epicenter's first-party browser apps keep their rows in `BROWSER_APPS`": every browser app's client id is its origin, and nothing is registered or hosted; CORS chosen by route stands.
- **Relates:** [ADR-0605](0605-an-app-is-an-ordinary-single-page-app-in-a-forkable-git-repository.md) (every app is a static site its author deploys), [ADR-0594](0594-a-hosted-repository-is-reached-only-by-the-person-who-owns-it.md) (a token reaches every repository its owner holds).
- **Unbuilt:** origin-identified clients and independent service consent under ADR-0614 and ADR-0634; no client metadata-document registration is required.

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

**A web app is identified for authorization by its web origin.**
The origin is its OAuth client_id. First sign-in creates the client record;
no developer registration or client metadata document is required
(ADR-0614). A public client uses PKCE S256. First-party apps follow the same
consent rules. Sign-in returns to the calling page on that origin.

**CORS policy follows each route's authentication mechanism.**
Token exchange and revocation accept credentialless cross-origin requests.
Bearer-token routes do not rely on browser cookies. Cookie routes use the
trusted-origin policy and credential handling. The presence of an
Authorization header alone does not classify the token-exchange route.

**Consent authorizes the requested service.**
Git consent targets a chosen repository. Inference can be authorized without
one. Neither sign-in nor consent is required to begin local use (ADR-0633).

## Consequences

- Client ID metadata-document discovery and its fetching policy are retired.
- Web origin, redirect URL, and Git remote URL remain distinct values.
- Native app identity remains a separate implementation question.
