# 0331. Whispering authenticates with an OAuth bearer on every surface; the web build keeps its own origin

- **Status:** Accepted
- **Implementation amendment (2026-09-07):** [ADR-0354](0354-hosted-applications-authenticate-with-better-auth-session-bearers.md) replaces first-party OAuth grants with signed Better Auth sessions for browser apps, Bun, and the dashboard. Tauri needs a protected handoff, not an Epicenter OAuth provider. The separate Whispering origin and explicit bearer transport remain. Short access-token TTL and refresh rotation below describe the removed implementation; live session validation and a 600-second socket bound replace them.
- **Date:** 2026-06-27
- **Renumbered from 0079 (2026-09-01).** Two branches each kept 0079 as a provisional number and both merged, so `ADR-0079` cited two decisions. The more-cited record keeps the integer and this one took the next free number. Every `ADR-0079` citation elsewhere in the tree means the record that kept it.
- **Amended by:** [ADR-0230](0230-an-auth-client-always-offers-openwebsocket-and-a-model-that-cannot-sync-denies-permanently.md): reason 1 below says the cookie client "is rejected at the type level" and calls it a plain `AuthClient` with no `openWebSocket`. That mechanism is withdrawn. `SyncAuthClient` is deleted, every client declares `openWebSocket`, and the cookie client denies permanently at runtime instead. The conclusion is unchanged: cookie auth still cannot drive sync, and Whispering still uses an OAuth bearer on every surface.
- **Relates:** [ADR-0053](0053-the-epicenter-bearer-is-an-audience-scoped-credential.md) (the bearer is audience-scoped, attached only to the origin it signed into), [ADR-0067](0067-auth-owns-the-session-endpoint-the-data-client-is-owner-scoped.md) (auth owns `/api/session`, the data client is owner-scoped), [ADR-0075](0075-self-host-is-a-single-partition-instance-behind-one-operator-supplied-bearer.md) (self-host is one partition behind one operator-supplied static bearer; supersedes ADR-0070) and [ADR-0071](0071-oauth-is-hosted-only-a-custom-instance-requires-a-token.md) (OAuth is hosted-only; a self-hosted instance authenticates with a static token), [ADR-0074](0074-the-secret-vault-is-an-owner-scoped-synced-store-encrypted-under-a-server-derived-keyring.md) (the secret vault consumes a server-derived keyring delivered over the authenticated session). Also relates to the portable-SPA stance (serve web apps same-origin under the api origin to use cookie auth, and not from branded subdomains).

## Context

Whispering is adding optional authentication so it can deliver the ADR-0074 per-owner keyring that unlocks the synced secret vault. Auth is purely additive: signed-out Whispering stays exactly as it is today, device-local, with no gate.

Whispering ships two surfaces:

1. A Tauri desktop app, the primary surface. Tauri is inherently cross-origin, so it must use OAuth/PKCE with the bearer in the OS keychain. This is not negotiable.
2. A web SPA, deployed at its own subdomain `whispering.epicenter.so` (a Cloudflare Workers custom domain), a separate origin from the hosted API at `api.epicenter.so`.

The monorepo already has two auth transports and we want to adopt one, not invent a third:

- The dashboard (`apps/api`) is served same-origin under the api origin and uses an httpOnly **cookie** session (`createSameOriginCookieAuth`). It does not sync; the cookie client is a plain `AuthClient` with no `openWebSocket`.
- Every cross-origin client (extension, CLI, and by nature Tauri) uses an OAuth/PKCE **bearer** (`createOAuthAppAuth`, or `createInstanceTokenAuth` for self-host), which returns a sync-capable `SyncAuthClient`. The bearer is audience-scoped (ADR-0053): it is attached only to the origin it signed into.

The forcing question for the web build: re-host it under the api origin to get the XSS-safe cookie, or keep its own origin and authenticate with OAuth like the desktop app?

## Decision

One transport, an OAuth bearer, on every Whispering surface. The web build stays at `whispering.epicenter.so`. Three reasons, in order of weight:

1. **Cookie auth cannot drive sync.** `createSession` (the workspace lifecycle binding cloud sync uses) requires a `SyncAuthClient`; the same-origin cookie client is a plain `AuthClient` with no `openWebSocket` and is rejected at the type level. The vault syncs over the relay WebSocket, so cookie auth for Whispering would require building a cookie-authenticated sync path (a ticket exchange or a new sync credential). That is a third auth shape, the opposite of unification.

2. **A cookie does not protect a JS-decrypted vault.** The vault's provider keys and the keyring itself are decrypted in JavaScript regardless of how the user signed in. An httpOnly cookie prevents durable theft of the login credential, but it does not stop same-origin script (an XSS hole) from reading the already-decrypted secrets out of the running app. For a client-decrypted vault, the cookie's headline benefit is largely neutralized.

3. **Whispering is desktop-primary, so OAuth must exist regardless.** A first-class OAuth/PKCE path is mandatory for the Tauri app. One OAuth transport across desktop and web is the consistent shape; ADR-0053's audience-scoped bearer is exactly the guard for a normal cross-origin app client.

The web bearer's XSS exposure is handled as hardening inside the OAuth choice, not by switching transport:

- Persist the web grant in `localStorage` (the shared factory default). An earlier draft of this ADR required `sessionStorage`, but its only real delta is a narrower left-behind window after tab close: live XSS reads either store while the app runs, and both are files on disk while the browser does. Its cost was the highest user-visible friction in the product, a sign-out on every tab close. The controls that actually bound a stolen grant are the ones below (short TTL, rotation, revocation, CSP). Desktop keeps its grant in the OS keychain.
- Keep access tokens short-lived with strict refresh rotation.
- Ship a tight CSP and Trusted Types where practical; treat the vault surface as high-risk.
- Never add cross-subdomain `.epicenter.so` cookies as a halfway cookie option.

Self-host authenticates with one operator-supplied static bearer (`createInstanceTokenAuth`), resolved to the single `principals/instance` partition per ADR-0075 and ADR-0092; nothing here adds a new mode.

## Consequences

- Whispering adopts `createAppAuthClient` unchanged. The `#platform/auth` build seam selects only the launcher and the persisted-grant storage per build: Tauri uses a deep-link callback launcher and the OS keychain; web uses a redirect launcher and the factory's persistent `localStorage` grant. No new auth client type is introduced.
- The "no branded subdomains" rule is about **cookie** apps: cross-subdomain cookies widen CSRF surface and blur audience boundaries. An OAuth app at its own subdomain is an ordinary cross-origin client, so the rule points toward this decision, not against it. `whispering.epicenter.so` stays.
- Auth stays optional and non-gating. Signed-out Whispering is unchanged (device-local), so this adds a credential, never a gate. Whispering remains a Shape B module-singleton app; the auth session is an additive overlay that owns only the vault doc and keyring, never the eager device-local recordings workspace.
- **Forecloses:** re-hosting the web build under the api origin for cookie auth, and a cookie-authenticated WebSocket sync path for Whispering. Re-introducing either re-litigates this ADR.

## Considered alternatives

- **Re-host the web build under `api.epicenter.so` for an httpOnly cookie.** Rejected: it forces a cookie-authenticated sync path (a new auth shape), gives up the brand subdomain, runs two transports for one app, and still does not protect the JS-decrypted vault from XSS.
- **Refuse the web vault entirely (desktop-only vault).** Rejected: it breaks cross-device sync from a key entered on the web app, which is the vault's whole purpose.
- **A BFF or token-proxy on `whispering.epicenter.so` issuing subdomain-scoped httpOnly cookies.** Rejected: it adds a second server session model and still does not protect client-decrypted secrets from XSS. Revisit only if the web app becomes the primary surface and vault access becomes account-critical.
