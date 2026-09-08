# Replace hosted OAuth grants with direct sessions

**Date:** 2026-09-07
**Status:** In Progress

## One sentence

Replace Epicenter's first-party OAuth grants with Better Auth session bearers
across browser apps, desktop-hosted apps, and the dashboard while preserving
the `Account` each application opened with.

The target is described in [ADR-0354](../docs/adr/0354-hosted-applications-authenticate-with-better-auth-session-bearers.md).
The sensitive-action policy is recorded in
[ADR-0356](../docs/adr/0356-sensitive-account-changes-use-better-auth-session-freshness.md):
optional passkeys, mutable linked providers, and ordinary session freshness.
The implementation still uses OAuth for apps and cookies for the dashboard.
Completion means those three surfaces use direct sessions, real Google/GitHub
sign-in works where configured, and account isolation survives renewal,
reauthentication, sign-out, and delayed work.

Read the ADR for the visual model. Start here at **Execution assumptions** and
**First proof: session issuance**. The [handoff](20260907T214002-direct-session-auth.handoff.md)
is a cold-start prompt, not another implementation plan.

## Execution assumptions

The user permits a complete break. Assume no users, no active logins, and no
installed client that must remain compatible. Intermediate commits and local
builds may fail to compile or run. Final verification is required; continuous
operability during the rewrite is not.

- Replace the persisted credential shape directly. Do not parse or exchange
  old OAuth grants. Development sessions and fixtures use the new format.
- Delete obsolete registrations, endpoints, exports, and configuration as the
  owning boundary changes. Do not add flags, aliases, or dual validators.
- Change the auth schema for a fresh database. Do not write a data migration
  or replay historical migrations solely to rescue obsolete OAuth rows. Use
  repository database tooling to produce the new baseline.
- Do not stage a rollout or retain a compatibility release. Existing login
  sessions do not need to survive. Git retains the removed implementation.
- The committed Account and desktop-relay implementation is the starting
  point. Replace its credential mechanism while preserving its invariants.
- The deliverable is a verified local change. Recreating a disposable test
  database is different from resetting a shared or production database. No
  deployment is needed to perform the implementation.

The normal build/prove/remove ordering is replaced by dependency order:
delete the old promise, rebuild the affected path, then prove the final system.
Unused source need not remain on disk as a rollback mechanism.

## Current evidence

The Account implementation is committed in `dca1909f60`, with documentation
follow-through in `f272e2ae34`. Recheck the checkout before editing; these refs
identify the baseline, while current code and package READMEs own the API.
`createEpicenter({ appId, definition }).open(account)`, Account-keyed session
components, retirement-safe transport, and the desktop HTTP/sync relay already
exist. This task replaces credential issuance and validation underneath them.

The baseline passed 282 targeted tests and affected typechecks. A packaged
native login smoke test remains unverified. The full-workspace typecheck also
reported a Skills test fixture missing `openWebSocket`; compare against the
baseline before attributing that failure to the credential replacement.

| Boundary | Read first | Current responsibility |
| --- | --- | --- |
| App contract | `packages/auth/src/auth-contract.ts`, `packages/auth/README.md` | Captured Account, auth state, dashboard AuthControls exception |
| OAuth runtime | `packages/auth/src/oauth-credential-authority.ts`, `packages/auth/src/oauth-account.ts` | Grants, refresh, verification, account retirement, transport |
| Browser | `packages/auth/src/hosted-browser-redirect-auth.ts` | App storage, OAuth launcher, callback convention |
| Dashboard | `apps/api/ui/src/lib/platform/auth.ts`, `apps/api/ui/src/lib/billing/api.ts` | Ambient cookie auth and billing calls |
| Hosted ceremonies | `apps/api/ui/src/lib/auth/client.ts`, `apps/api/ui/src/routes/dashboard/account/+page.svelte` | Login methods and passkeys |
| Desktop | `apps/epicenter/src/desktop-auth-authority.ts`, `packages/auth/src/desktop-broker-auth.ts`, `apps/epicenter/src/server.ts` | Host-held grant, captured-account relay, WebView bootstrap |
| Resources | `packages/server/src/middleware/require-auth.ts`, `packages/server/src/store-sync/mount.ts` | JWT/cookie resolution and WebSocket bearer extraction |
| Session engine | `packages/server/src/auth/create-auth.ts`, `packages/server/src/auth/base-config.ts`, `packages/server/src/auth/plugins.ts` | Providers, session policy, freshness hook, plugins |
| Schema | `packages/server/src/db/schema/auth.ts` | Better Auth, OAuth, and JWKS tables |

The resource verifier checks JWT signature, issuer, audience, expiry, subject,
and user existence. It does not enforce per-app permissions. A database user
lookup already follows JWT verification. The old path is neither database-free
nor an existing granular authorization system.

### Behavior to carry forward

Preserve the scenarios in these tests, adapting OAuth fixtures to session
credentials instead of preserving obsolete helper names:

- `packages/auth/src/account-lifetime.test.ts`: stable Account identity,
  retirement during authorization, caller cancellation independent of shared
  renewal, disposal during refresh, origin rejection, and request-body replay.
- `packages/auth/src/desktop-broker-auth.test.ts`: bootstrap and stale response
  handling. The current broker learns recovery from the next host bootstrap;
  an older successful HTTP response must not overwrite a newer auth refusal.
- `apps/epicenter/src/account-transport.test.ts`: real HTTP and sync forwarding,
  credential stripping, compressed responses, exact bytes, and paired closure.
- `apps/whispering/src/lib/services/blobs/account-blob-remote.test.ts`: delayed
  local reads and retries cannot switch to a successor account.

Account identity is stable within a running auth authority. Browser navigation
or desktop host relaunch creates another runtime and application session.
Local sign-out retires transport immediately; remote revocation is enforced by
server validation and the chosen socket authorization bound. These are separate
lifetimes and should have separate evidence.

The desktop supervisor and relay tests avoid awaiting Bun's force-stop promise
after server-initiated socket closure: an isolated baseline reproduction closed
both endpoints but left Bun's pending-socket count stuck. Preserve owner disposal
and verify actual socket closure; recheck the runtime bug before removing the
workaround. See `apps/epicenter/src/sidecar-runtime.test.ts`.

The recent session and desktop discussions retain app-owned data and the
Account object as the session key. Blob API proposals do not change that
boundary. A separate review raised an unreproduced race between recording
cleanup and database closure. Do not redesign recording shutdown or blob
storage as part of replacing the auth credential.

### Library findings to reproduce

The inspected packages were Better Auth and OAuth Provider 1.6.23. Recheck the
installed version; current online documentation may describe a later version.

- `better-auth/dist/plugins/bearer/index.mjs` converts a session bearer to the
  signed session-cookie header Better Auth reads. It does not validate an
  Epicenter OAuth JWT as a session. New credentials can be exposed through
  `set-auth-token` response headers.
- `better-auth/dist/api/routes/session.mjs` checks and extends session expiry.
  `freshSessionMiddleware` uses `session.createdAt`. Ordinary renewal does not
  create a fresh authentication event.
- `better-auth/dist/plugins/one-time-token/index.mjs` consumes a value and
  returns its existing session. Its verify body contains only the token. That
  does not prove PKCE binding or independent client issuance.
- Global `hooks.before` is collected before plugin before-hooks in
  `better-auth/dist/api/dispatch.mjs`. Test the custom freshness hook with a
  header-only session; enabling `bearer()` alone is not proof it works.
- `requireFreshCookieSession` in `apps/api/worker/account/routes.ts` calls
  `getSession` without explicitly rejecting authorization headers. Enabling
  `bearer()` can change who passes it. Its name and comment are not a guard.
- Store transport lives under `packages/server/src/store-sync`. Do not assume
  socket-lifetime protections described for retired rooms routes exist here.
  Inspect the current authority and test the actual timeout.

[Better Auth bearer docs](https://better-auth.com/docs/plugins/bearer) describe
the session-header mechanism. The [session docs](https://better-auth.com/docs/concepts/session-management)
cover expiry and freshness. The [Electron integration](https://better-auth.com/docs/integrations/electron)
demonstrates a PKCE/state handoff with main-process credentials; it is not a
verified Tauri integration. [RFC 8252](https://www.rfc-editor.org/rfc/rfc8252.html)
explains native browser and interception protections worth preserving.

## First proof: session issuance

### Local evidence, 2026-09-07

`packages/server/src/auth/session-handoff.ts` is an unmounted issuance plugin.
Its endpoint tests exercise installed Better Auth 1.6.23 with a disposable
memory adapter. Twelve tests pass: independent sessions and revocation,
PKCE/state/exact callback binding, concurrent redemption and replay, source
revocation and code expiry, ambient credential/origin rejection, timestamp
preservation, session lookup renewal, and rejection by a different signing
secret. The server typecheck passes.

This is partial first-proof evidence. It does not exercise browser or native
launchers, cancelled callbacks, real provider sign-in, production resource
middleware renewal, or cross-process Postgres consumption. The installed
Drizzle adapter implements `consumeOne` with `DELETE RETURNING`; the concurrent
memory test alone does not prove deployment atomicity. The plugin is not
mounted beside the existing OAuth path.

The product direction now accepts ordinary Better Auth session freshness.
Use one 600-second window for sensitive account changes, including deletion.
Handoff inherits the source session's `createdAt`; renewal does not reset it.
A completed social sign-in may start that window even when provider SSO is
silent. This deliberately does not promise fresh human interaction. Passkeys
remain optional and linked providers remain mutable.

Adversarial review identified an important cost: a stolen fresh session bearer
can authorize sensitive actions remotely. A signed bearer can also be presented
as the Better Auth session cookie. Cookie-only route names, Origin checks, and
personal-device ownership do not establish a separate credential boundary.
Preserve browser request protections, but do not claim they contain bearer
theft. ADR-0356 records this tradeoff and when to revisit it.

### Protocol to prove

Demonstrate hosted sign-in to one browser client and the Bun host before scaling
the new design across callers. Isolated fixtures and broken production callers
are acceptable during this proof. It is not a compatibility phase.

```txt
Browser client / Bun host       Hosted auth origin       Google / GitHub
          |                           |                         |
  create verifier + state             |                         |
          |-- challenge, callback --->|                         |
          |                           |---- social sign-in ---->|
          |                           |<--- verified identity --|
          |<-- code + returned state -|                         |
  verify local state                  |                         |
          |-- code + verifier ------->|                         |
          |                           | validate binding        |
          |                           | consume code once       |
          |                           | issue client session    |
          |<-- session credential ----|                         |
  persist; verify principal           |                         |
  publish captured Account            |                         |
```

This is the protocol shape of the unmounted local plugin; end-to-end client
completion remains unproven. Prefer supported Better Auth facilities or one
small Better Auth plugin. Do not
reconstruct an OAuth provider with scopes, grants, discovery, and registration
tables under session names.

Required evidence:

- The code is short-lived, consumed atomically once, and bound to the initiating
  verifier and exact allowed callback. Another client cannot redeem an
  intercepted code. The initiating client validates state.
- An unsolicited, replayed, cancelled, timed-out, or duplicate callback cannot
  install an account. Callback reloads cannot spend the same code twice.
- The hosted login session and client sessions have independent revocation
  lifetimes. Copying the login session into every app does not satisfy this.
- Issuance and renewal cannot reset source session age. A completed social or
  passkey sign-in can start a new freshness window under ADR-0356; merely
  visiting the hosted page with an existing cookie cannot. Test actual sensitive
  endpoints, the 600-second boundary, hook ordering, and the invoking principal.
- Tokens never enter redirect URLs, logs, bootstraps, or native WebViews.
  Development callbacks are allowed explicitly, not by substring matching.
- The dashboard uses the same browser ceremony on the issuer origin. Inventory
  `/auth/*` routing: the current callback convention may collide with Better
  Auth's own handler on that origin.

If the replacement demands a large bespoke authentication server, expose that
evidence before scaling it out. Broken intermediate callers are acceptable;
an unverified handoff is not a completed replacement.

## Contract and caller changes

Keep the existing `Account` contract and app-owned data sessions. Remove the
dashboard exception when it can make the same account promise. The following
after examples are proposed API changes, not existing signatures.

### Browser composition

Current excerpt from `apps/honeycrisp/src/lib/platform/auth.browser.ts`:

```ts
export const authClient = createHostedBrowserRedirectAuth({
	appId: APPS.HONEYCRISP.id,
	oauthClientId: EPICENTER_HONEYCRISP_OAUTH_CLIENT_ID,
	baseURL: APP_URLS.API,
});
```

After its constructor uses direct sessions:

```ts
export const authClient = createHostedBrowserRedirectAuth({
	appId: APPS.HONEYCRISP.id,
	baseURL: APP_URLS.API,
});
```

The app ID scopes storage, not OAuth registration or permission scopes. Keep
explicit callback allowlisting at issuance. Retain the constructor name if it
still describes its job; a token-type rename is unnecessary.

An independently maintained frontend, such as the proposed Zhongwen app, can
use this composition from an explicitly approved origin. A separate repository
or domain does not require an OAuth provider. Preserve exact callback approval,
CORS, and trusted-origin configuration when deleting OAuth registrations; do
not turn issuance into arbitrary-site access. This assumes the application is
trusted with the person's resource access. Untrusted clients needing limited
delegation would reopen the authorization decision. Package distribution and
the external application's deployment remain separate work.

### Dashboard composition

Current excerpt from `apps/api/ui/src/lib/platform/auth.ts`:

```ts
export const authClient = createSameOriginCookieAuth({
	baseURL: window.location.origin,
});
```

Proposed composition:

```ts
export const authClient = createHostedBrowserRedirectAuth({
	appId: DASHBOARD_APP_ID,
	baseURL: window.location.origin,
});
```

`DASHBOARD_APP_ID` is a proposed constant to define with application IDs. There
is no second dashboard auth factory. Billing functions receive the captured
Account or its fetch; their query cache is scoped to the attachment. They do
not reread the controller's current account on every request. A principal-only
cache key cannot distinguish signing out and back into the same account. Use
an attachment-owned cache or an explicit attachment identity, and ensure a
retired attachment's late results cannot enter the replacement's UI.

### Resource guard

Current excerpt from `packages/server/src/middleware/require-auth.ts`:

```ts
const session = await c.var.auth.api.getSession({
	headers: c.req.raw.headers,
});
```

This runs inside cookie-first fallback resolution. The replacement parses one
explicit bearer, supplies only the session-auth headers needed by Better Auth,
and resolves that session. HTTP and WebSocket admission share that resolver.
An unrelated browser cookie is never forwarded as a fallback. The helper name
is an implementation decision.

### Existing application consumers

`apps/honeycrisp/src/routes/components/NotesSession.svelte` already calls
`epicenter.open(account)`. The desktop WebView already receives a broker-backed
Account. Their credential owner changes underneath the existing app model.

## Replacement order

These are dependency checkpoints, not independently releasable waves. Broken
imports may remain until the next checkpoint. An obsolete path can be deleted
before its replacement works; no rollback implementation needs to remain live.

1. **Remove the old promise.** Delete or disconnect Epicenter's OAuth provider,
   grant contracts, cookie-resource client, registrations, and dual guards.
   Use compiler errors as the caller inventory. Keep upstream social login.
2. **Establish issuance and the session schema.** Reproduce the first-proof
   cases with installed Better Auth. Choose the handoff and callback paths.
   Record token ownership and source-session-age preservation. Rebuild
   disposable auth fixtures from the new schema.
3. **Implement the shared credential owner and resolver.** Persist the session
   credential and local principal. Resolve hosted HTTP and socket credentials
   through Better Auth. Keep account retirement, verification before network
   use, origin checks, infrastructure error distinctions, and stale-result
   suppression. Reconsider existing authority wrappers instead of renaming
   every OAuth helper one-for-one.
4. **Wire browser apps and dashboard together.** Use one browser composition.
   Complete callbacks outside data boot gates. Bind dashboard requests and
   query state to its account. Remove `AuthControls` if no independent need
   remains. Remove the cookie client rather than keeping an alias.
5. **Wire the desktop host.** Replace its OAuth exchange and persisted grant.
   Keep native storage, bootstrap identity, captured boot account, and relays.
   Test failed relaunch and old-window work. Authentication must support the
   dashboard in the host; adding dashboard navigation can be a separate UI
   task if it is not already part of the implementation request.
6. **Complete session policy and sensitive ceremonies.** Verify renewal through
   ordinary bearer traffic. Enforce a socket authorization bound, including
   idle/hibernating connections. Make login changes and deletion use fresh
   sessions under the shared 600-second policy, bound to the invoking principal.
   No per-app scopes are added.
7. **Remove stragglers and verify the whole system.** Delete orphan OAuth tables,
   relations, imports, exports, constants, dependencies, scripts, tests, and
   stale instructions. Run the matrix below. Update package READMEs when their
   statements describe working code.

No OAuth compatibility path needs to survive checkpoint 1. Do not add a token
kind discriminator just to make an intermediate checkpoint compile.

## What collapses

| Boundary | Change | What must survive |
| --- | --- | --- |
| Epicenter as OAuth provider | Delete app registrations, grants, refresh exchange, JWT resource verification, discovery, and consent | Explicit origins and exact callback approval; Google/GitHub provider credentials |
| Client credential ownership | Persist one session credential and principal; remove refresh-token rotation and grant-expiry bookkeeping | Verification, ordered persistence, cancellation, stale-result suppression, permanent Account retirement |
| Dashboard | Replace ambient-cookie resources and the AuthControls exception with the shared browser Account composition | Browser management ceremonies and an attachment-owned query cache |
| Sensitive-action proof | Avoid building verified-human timestamps, mandatory enrollment, email step-up, and recovery for a required factor | One session-age policy and principal-bound checks on real routes |
| Desktop | Replace the host credential machinery, not the relay architecture | Native credential storage, local broker cookies, credential-free WebViews, captured boot Account |

The fourth row avoids unbuilt complexity; it is not a claim that those systems
already exist and can be deleted. Remove unused extension launchers or storage
wrappers only after confirming they have no callers. Do not replace each OAuth
wrapper with an identically layered session wrapper. Separate state only when
it owns a real lifetime, concurrency rule, or platform boundary.

## Expected file changes

This is a starting inventory, not a promise to edit every file. Recheck callers
before deletion. Tests keep their behavioral coverage even when helpers vanish.

| Area | Likely files or directories | Work |
| --- | --- | --- |
| Server configuration | `packages/server/src/auth/plugins.ts`, `packages/server/src/auth/base-config.ts`, `packages/server/src/auth/create-auth.ts` | Remove provider/JWT plugins; configure bearer signatures, duration, and shared freshness |
| Handoff | `packages/server/src/auth/session-handoff.ts`, `packages/server/src/auth/session-handoff.test.ts` | Finish and mount the bounded PKCE ceremony; prove deployment adapter behavior |
| Fresh database | `packages/server/src/db/schema/auth.ts`, `apps/api/drizzle/` | Remove JWKS and Epicenter OAuth client/access/refresh/consent tables and relations; regenerate a fresh baseline |
| Auth routing | `packages/server/src/routes/auth.ts`, `packages/server/src/middleware/require-auth.ts` | Remove discovery/consent handling and dual resolution; retain exact redirects and distinguish infrastructure failures |
| Sensitive actions | `apps/api/worker/account/routes.ts`, `apps/api/ui/src/lib/auth/client.ts`, `apps/api/ui/src/routes/dashboard/account/+page.svelte` | Shared freshness and captured-principal binding; preserve provider and passkey ceremonies |
| Client authority | `packages/auth/src/oauth-credential-authority.ts`, `packages/auth/src/oauth-account.ts`, `packages/auth/src/create-oauth-app-auth.ts`, `packages/auth/src/credential-authority.ts` | Replace grant ownership and collapse wrappers where ownership permits |
| Obsolete clients | `packages/auth/src/oauth-token-endpoints.ts`, `packages/auth/src/same-origin-cookie-auth.ts` | Delete grant exchange and ambient-cookie resource implementations |
| Contracts and storage | `packages/auth/src/auth-contract.ts`, `packages/auth/src/auth-types.ts`, `packages/auth/src/auth-errors.ts`, `packages/auth/src/persisted-auth-storage.ts`, `packages/auth/src/index.ts`, `packages/auth/src/svelte/auth.svelte.ts` | Session-only persisted shape and errors; remove dashboard exception without weakening Account |
| Browser ceremony | `packages/auth/src/hosted-browser-redirect-auth.ts`, `packages/auth/src/oauth-launchers/`, app callback routes | Shared session composition; transaction expiry, cancellation, exact callback and state checks |
| Browser consumers | `apps/honeycrisp/src/lib/platform/auth.browser.ts`, `apps/whispering/src/lib/platform/auth.browser.ts`, `apps/vocab/src/lib/auth.ts` | Adopt the shared composition beneath existing Account gates |
| Shared sign-in UI | `packages/app-shell/src/account-popover/account-popover.svelte`, `packages/app-shell/src/account-popover/sign-in-panel.svelte`, `packages/app-shell/src/boot-screens/sign-in-screen.svelte` | Adapt AuthControls consumers when the contract exception is removed |
| Dashboard attachment | `apps/api/ui/src/lib/platform/auth.ts`, `apps/api/ui/src/lib/query/client.ts`, `apps/api/ui/src/routes/+layout.svelte`, `apps/api/ui/src/routes/dashboard/+layout.svelte` | Captured Account and attachment-owned QueryClient; callback outside issuer handler paths |
| Dashboard callers | `apps/api/ui/src/lib/billing/`, `apps/api/ui/src/lib/account/`, `apps/api/ui/src/lib/auth/session.ts`, dashboard pages and components | Captured bearer requests; prevent late results entering a successor attachment |
| Hosted sign-in | `apps/api/ui/src/routes/sign-in/+page.svelte`, `apps/api/ui/src/lib/auth/oauth-query.ts`, consent route | Replace OAuth request continuation and delete consent UI |
| Desktop owner | `apps/epicenter/src/desktop-auth-authority.ts`, `apps/epicenter/src/sidecar-runtime.ts`, `apps/epicenter/src-tauri/src/lib.rs` | Session persistence and cancellable native completion; preserve failed-relaunch isolation |
| Desktop relay | `apps/epicenter/src/server.ts`, `apps/epicenter/src/account-relay.ts`, `packages/auth/src/desktop-broker-auth.ts` | Adapt fixtures and credential assumptions; retain relay lifetimes and token stripping |
| Live sync | `packages/server/src/store-sync/authority.ts`, `packages/server/src/store-sync/mount.ts` | Persist a short authorization deadline; enforce it during idle and hibernation as well as sends |
| Registration cleanup | `packages/constants/src/`, `apps/api/scripts/seed-oauth-clients.ts`, `scripts/check-api-paths.ts`, package manifests and lockfile | Delete registration/seed/scope machinery and unused direct dependencies; preserve origin policy |
| Public documentation | `packages/auth/README.md`, ADRs 0071, 0331, 0353, 0354, 0356 | Describe verified behavior; amend only the decisions this change replaces |

Carry forward `account-lifetime`, `desktop-broker-auth`, and
`refusal-is-not-an-identity-change` tests in `packages/auth/src`, launcher and
storage cases, the desktop authority/transport/supervisor/server regressions,
and Whispering's delayed blob-operation tests. Add dashboard attachment tests,
real sensitive-route tests, and Workers hibernation evidence. Do not delete
isolation coverage merely because a test filename contains OAuth.

## Next checkpoint

Server checkpoint implemented locally on 2026-09-07. The handoff is mounted
with signed bearers and the fresh session-only Postgres baseline. No shared
database was changed and nothing was deployed.

Verified evidence:

- 85 server auth/resource/route tests passed together; an additional renewal
  failure test now exercises `updateSession` throwing, and the concurrent
  deletion test exercises `updateSession` returning null rather than a mocked
  resolver verdict.
- Eight disposable Postgres tests include two separate Bun processes racing
  one code through the deployment Drizzle adapter. Exactly one client session
  was issued. Revocation and source authentication age remain independent.
- The shared handoff client passes 14 tests over real Bun HTTP with browser
  and native callback URLs, persisted transactions, duplicates, expiry,
  cancellation, supersession, and orphan revocation. This is a protocol harness,
  not an interactive browser or packaged native smoke test.
- All 24 Workers tests pass, including the real hosted deletion gate and eight
  socket-deadline tests. The authority persists a server-computed 600-second
  deadline and enforces it on input, output, catch-up, and idle alarms.
- Server source and Workers typechecks pass. Sensitive routes use the public
  Better Auth session API before checking expected principal and 600-second
  age. This avoids the upstream before-hook header-normalization ordering trap.

The security and greenfield checkpoint reviews are complete. Chromium
151.0.7922.34 passed the opt-in smoke at
`packages/auth/smoke/session-handoff.browser.mjs`, including real navigation,
sessionStorage persistence, CORS preflights, cookie-free redemption and resource
requests, encoded WebSocket credentials, and reload replay refusal. The smoke
uses disposable hosted-login fixtures, not real provider credentials. The
hosted sign-in UI now presents explicit handoff continuation and the API UI
typecheck passed. Packaged native login remains unverified.

Next: replace the shared client credential owner and its browser/dashboard/Bun
consumers, then verify their Account lifetimes and real UI integrations.

The independent review reproduced two integration defects: signed bearer
padding was illegal in the raw WebSocket subprotocol, and separate handoff
clients sharing storage could accept an older response after the newer attempt
completed. Both are fixed and re-reviewed. The handoff retains shared version
tombstones and local cancellation generations, including storage-write failure;
17 protocol tests pass. A real Bun WebSocket constructor and mounted hosted
store gate accept an issued, encoded signed session, then refuse admission after
revocation.

The greenfield review also found a pre-existing account-deletion limitation:
`runAccountDeletion` has no store-authority erasure step and `deleteStore` has
no callers. The fresh-session gate tests do not prove complete erasure. Socket
expiry bounds access, not data retention. Store-wide deletion ownership needs
separate implementation; do not claim this auth change fixes it.

Checkpoint requirements and their remaining evidence:

1. Mount the handoff against the fresh session schema, remove the provider
   path, and test atomic redemption with the actual deployment adapter across
   separate connections. A memory-adapter race test is insufficient.
2. Exercise bearer-only resource routes, renewal through ordinary traffic,
   revocation, deployment isolation, and database failure classification.
3. Exercise real management routes with stale, fresh, mixed-credential, and
   wrong-principal requests. Verify hook order and the exact freshness boundary.
   Preserve the original principal in provider-link callback state. Sign-out
   cannot undo a linking operation already authorized at initiation.
   Test implicit same-email linking during social sign-in separately: it uses
   the existing provider/email policy, not a prior captured Account session.
4. Complete one browser and one Bun-host ceremony, including cancellation,
   duplicate callbacks, and older completion after a newer account choice.
   A stale redemption must never install its session; revoke an orphaned result
   where possible. Validate exact callbacks, including rejection of `//host`.
5. Prove the socket deadline is feasible in the live authority before declaring
   resource revocation complete. Then apply the shared client ownership model
   across callers in the replacement order above.

There is already a spec and a cold-start handoff. Update those as evidence
changes; another planning document would duplicate ownership. Future collapse
should follow demonstrated redundant state, not remove Account lifetimes or
weaken origin approval. Stronger authentication, limited third-party delegation,
external package distribution, and blob API redesign are separate decisions.

## Remaining execution decisions

| Question | Recommended direction | Required evidence |
| --- | --- | --- |
| Issuance mechanism | One PKCE/state ceremony using supported Better Auth facilities | Browser and real Tauri/Bun callback exchange; replay and cross-client rejection |
| Remembered login | A 30-day sliding client session is the starting candidate, matching the intent of the existing refresh grant | Compare current 7-day session/daily extension; choose and test final values |
| Freshness at issuance (settled) | Inherit source `createdAt`; ordinary completed sign-in can reset it | Handoff and renewal cannot reset the 600-second sensitive-action window |
| Sign-out | Revoke the selected client session and retire its Account | Independent-client revocation; specified hosted SSO behavior after app sign-out |
| Persistence | One explicit credential per browser client; native storage for the desktop host | Multi-tab behavior, storage failures, no raw token in WebView |
| Socket authorization | Short server-enforced interval, revalidation on reconnect | Live authority tests for idle and hibernating sockets |
| Environment isolation | A deployment accepts only its own session credentials | Separate stores/secrets or equivalent binding; client origin checks do not replace server audience validation |

These are evidence and policy choices within the target, not invitations to
restore compatibility. Expose any choice that changes the product promise.

## Final verification matrix

| Scenario | Required outcome |
| --- | --- |
| Google and configured GitHub login | Browser SPA, dashboard, and desktop obtain usable Epicenter sessions |
| Wrong verifier, state, redirect, or replayed callback | No session installed or disclosed |
| Old Alice callback arrives after Bob was selected or sign-out cancelled the flow | Ignore the stale completion; no account installed or newer selection overwritten |
| Current, deliberately initiated sign-in selects another principal | Retire the old attachment before publishing the replacement |
| Sign-out during validation, renewal, fetch, stream, or socket open | Old work cannot use a successor credential |
| Sign-out then same-person sign-in | Old Account stays retired; new Account works |
| Same-person renewal or reauthentication within the running authority | Preserve Account identity and the mounted local session |
| Browser navigation or desktop host relaunch | Recreate the runtime and session; no promise of preserving an in-memory Account across processes |
| Network or session-database outage | Local data remains; infrastructure failure is not invalid credentials |
| Expired, revoked, or unknown session | Network refused; deliberate reauthentication can restore access |
| Invalid bearer with valid unrelated cookie | No cookie fallback |
| Cross-origin target or redirect | No Epicenter credential leaves its server |
| Dashboard account switch | Old requests and cached profile/usage cannot render as the next account |
| Native relaunch fails | Old windows never obtain the replacement account's authority |
| Sensitive action with stale or wrong-principal browser session | Reject at 600 seconds or principal mismatch; require a matching recent sign-in |
| Completed social sign-in with provider SSO | New freshness window is allowed; do not describe it as proof of human interaction |
| Fresh signed bearer presented as a session cookie | Recognize the same credential authority; do not assert cookie-only theft containment |
| Revocation during idle sync | Authorization ends within the documented bound, including hibernation |
| Self-host token | Static-token principal resolution stays independent of Better Auth |

Run affected tests and leaf checks from the repo root. Confirm paths against
the final layout rather than preserving old filenames for this plan:

```sh
bun test packages/auth/src packages/app/src
bun test apps/whispering/src/lib/services/blobs/account-blob-remote.test.ts
bun test packages/server/src/middleware packages/server/src/auth
bun test packages/server/src/store-sync
bun test apps/epicenter/src
bun test apps/api/worker/account apps/api/worker/billing
bun test apps/whispering/src/lib/services/blobs/account-blob-remote.test.ts
bun run --cwd packages/auth typecheck
bun run --cwd packages/server typecheck
bun run --cwd apps/api typecheck
bun run --cwd apps/api/ui typecheck
bun run --cwd apps/epicenter typecheck
bun run --cwd apps/vocab typecheck
bun run --cwd apps/api/ui build
bun scripts/check-doc-hygiene.ts
bun scripts/check-doc-paths.ts
```

Use root `bun dev:honeycrisp`, `bun dev:epicenter`, and `bun dev:api` for the
appropriate smoke sessions. Check root scripts before starting processes and
avoid starting the same backend twice. Real provider/native flows need smoke
evidence in addition to mocked tests. Add the existing Workers test harness
when proving socket hibernation, which a browser-only test cannot establish.

## Documentation and completion

When the new decision is authorized to govern, reconcile the older records:
amend the hosted OAuth requirement in ADR-0331 and ADR-0071 with reciprocal
links, retaining their unrelated origin and self-host decisions. ADR-0353's
current dashboard paragraph already allows a future explicit-credential
Account. When dashboard adoption works, update that implementation context and
the auth README; preserve the account lifetime decision. Its amendment links to
ADRs 0230, 0339, and 0350 already record the transport and session API change. Do not mark records accepted on the implementer's
own judgment.

Delete this spec and its handoff when the work is complete. Keep the ADR and
current package READMEs. Completion requires one active session-credential path
for the three hosted clients, no OAuth fallback, and evidence for the matrix.
A compiling browser demo alone is not completion.
