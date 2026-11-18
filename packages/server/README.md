# `@epicenter/server`

This Hono library gives the Cloudflare Worker and the Bun server in
`apps/api` the same OAuth authorization server, inference gateway, and
transcription gateway. The deployment chooses its origin and trusted origins
through `createServerApp`. That origin is also the audience for both gateways.
The [Worker entry](../../apps/api/worker/index.ts) shows how the hosted API
adds dashboard billing to these shared routes.

## Request lifecycle

`createCloudContextMiddleware` acquires a Postgres handle for each route that
needs it and closes it once queued work settles. The Worker acquires it through
Hyperdrive and drains the queue with `waitUntil`. Bun borrows its process-wide
`pg.Pool`. Public sign-in, consent, and device page shells bypass this
middleware. Each deployment serves the shells from its own UI build.

Both gateways use `requireAccessToken({ scope: 'ai' })`. It checks the
opaque token against Postgres on every request, including its expiry,
revocation, exact audience, scope, and any approving session it depends on.
A 401 or 403 includes a `WWW-Authenticate` header with a link to the API's
protected resource metadata. The Worker attaches metering after this check.
The billing implementation lives in `apps/api/worker/billing/`.

## Authorization server

`mountAuthRoutes` serves discovery and Better Auth's endpoints under
`/auth/*`. Only those database-backed routes initialize the OAuth provider.
`registerFirstPartyClients` seeds the API origin as a resource and makes
each first-party client's resource links match its registration. Bun calls
it at boot. The Worker calls it once per isolate before the first
authorization-server request.

The [OAuth policy](src/auth/oauth-policy.ts) defines access and refresh
lifetimes. When a reused refresh token falls outside the reuse interval, the
provider revokes every grant and access token for that client and person.
Native offline grants outlive the approving browser session. Web client
grants remain tied to that session and end at sign-out.

The dashboard uses `requireSessionCookie()` for account management. The guard
checks the live Better Auth session and any expected principal supplied by the
page. State changes must name the API origin. Better Auth's account-management
hooks also require a fresh session for changes to sign-in methods.
See [ADR-0549](../../docs/adr/0549-every-epicenter-resource-accepts-only-opaque-access-tokens-from-one-oauth-authorization-server.md).

## Tests that need Postgres

`src/auth/oauth-server.postgres.test.ts` starts a private cluster using
`initdb` and `pg_ctl`, applies the migrations from `apps/api/drizzle`, and
stops the cluster afterward. The same OAuth checks also run against the Bun
and Worker entrypoints in `apps/api/oauth-server.postgres.test.ts`.
