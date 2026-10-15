# 0549. Every Epicenter resource accepts only opaque access tokens from one OAuth 2.1 authorization server

- **Status:** Proposed
- **Date:** 2026-10-15
- **Supersedes:** [ADR-0071](0071-oauth-is-hosted-only-a-custom-instance-requires-a-token.md), whose hosted-only OAuth and static self-host token give way to one authorization server in every deployment; [ADR-0076](0076-the-relational-auth-substrate-is-a-cloud-only-layer-the-instance-composes-neither.md), whose self-host composes neither Better Auth nor Postgres.
- **Amends:** [ADR-0331](0331-whispering-authenticates-with-an-oauth-bearer-on-every-surface.md) at its web-grant hardening (a refresh token in `localStorage`, refresh rotation in the browser) and its self-host `createInstanceTokenAuth` sentence; [ADR-0075](0075-self-host-is-a-single-partition-instance-behind-one-operator-supplied-bearer.md) at the operator-supplied `INSTANCE_TOKEN` and at self-host running on Cloudflare; [ADR-0326](0326-the-deployment-names-the-authority-and-a-person-never-types-one.md) at its clause that a custom instance still requires a token.
- **Unbuilt:** all of it: `@better-auth/oauth-provider` with `oauthDeviceAuthorization()` and `@better-auth/cimd` in `packages/server/src/auth/plugins.ts`; the lineage patch; the resource query; the consent and device approval pages with the target picker; the devices and grants list; `epicenter login` and `epicenter git-credential`; the browser redirect renewal; the Bun self-host on Postgres; deleting what the Decision names.

## Context

Today every hosted request carries a Better Auth session.
`packages/server/src/auth/plugins.ts` composes `bearer({ requireSignature: true })`,
`sessionHandoff`, and `passkey`. `sessionHandoff` (`session-handoff.ts`) issues
an independent session per client through a 120-second single-use code bound to
S256 PKCE, state, and an exact callback. Sessions last 30 days and renew after a
day of use (`session-policy.ts`). Every session can do everything the person
can, including account changes within `freshAge` ([ADR-0356](0356-sensitive-account-changes-use-better-auth-session-freshness.md)).
Self-host runs a second owner of the same wire, `packages/server/src/self-host-auth/`,
on `bun:sqlite` or the `SelfHostAuthOwner` Durable Object.
`packages/server/src/auth/instance-token.ts`, `packages/auth/src/instance-token.ts`,
and `apps/self-host/scripts/gen-token.ts` have no runtime caller.
[ADR-0546](0546-a-folder-syncs-to-git-epicenter-so-under-its-owners-namespace-and-the-first-push-creates-it.md)
planned the device's session as its Git credential, with Better Auth's core
`deviceAuthorization()` behind `epicenter login` and its API key package for
narrower keys.

Epicenter has run OAuth before and left it:

| When | Commit | What happened |
| --- | --- | --- |
| 2026-03 | `f2380359c5`, `32580fa161` | `@better-auth/oauth-provider` with the `jwt` plugin and JWKS, PKCE, a 600-second access token, `refreshTokenReuseInterval: 60`, no dynamic registration; the core device plugin for a CLI runner |
| 2026-05-12 | `575dbea6d8` | Device login removed: the core plugin "issues session tokens, not OAuth resource tokens", which failed the resource check |
| 2026-05-20 | `9a70f99ee8` | The `workspaces:open` scope collapsed: no route enforced it |
| 2026-07-31 | `3e5d491455` | CLI machine auth deleted |
| 2026-08-28 | `47a48940fd` | A duplicate refresh at reuse interval 0 deleted the `(clientId, userId)` refresh family and signed the person out of every device |
| 2026-09-07 | `0c329cbb54`, `23bade0df4` | Session bearers and `sessionHandoff` replace OAuth (ADR-0354, since deleted) |

ADR-0354 chose sessions because every client was first-party with identical
access, no route enforced a scope, every client skipped consent, and a person
paid for two credential lifecycles: an OAuth grant to act and a session to sign
in. It said that giving an untrusted client limited, delegated access would
reopen the decision.

Three things reopen it:

- Third-party MCP clients (Claude, ChatGPT) need delegated, consented, limited
  access to a person's folders. The MCP authorization specification of
  2026-07-28 requires RFC 9728 discovery, PKCE, audience-bound tokens, and
  rotating refresh tokens for public clients, and says an MCP server "MUST NOT
  accept or transit any other tokens."
- Git credentials for terminals and agents. A session handed to `git` by a
  credential helper can delete the account, and Git calls `store` on every
  configured helper after a successful request, so a system `osxkeychain`
  helper may copy it into the login keychain.
- Better Auth 1.7.9 fixes both earlier failures. `oauthDeviceAuthorization()`
  in `@better-auth/oauth-provider` issues OAuth tokens. A spike on 2026-10-15
  (Better Auth 1.7.9 under `wrangler dev --local` with Hyperdrive and on Bun
  1.3.14, both against Postgres 18) reproduced the family deletion and fixed it
  by keying the family on grant lineage.

Once an authorization server must exist for MCP, keeping sessions for
first-party clients puts two credential kinds at every resource, which is the
cost ADR-0354 removed.

## Decision

**Epicenter is one OAuth 2.1 authorization server, and it issues every
credential a client holds.** It is Better Auth 1.7.x under the `/auth` base
path on `https://api.epicenter.so`:

```txt
packages/server/src/auth/plugins.ts
  oauthProvider({ disableJwtPlugin: true, refreshTokenReuseInterval: 60, resources: [...] })
                               @better-auth/oauth-provider; opaque tokens; no jwt plugin, no jwks table
  oauthDeviceAuthorization()   @better-auth/oauth-provider; RFC 8628, issues OAuth tokens
  cimd(...)                    @better-auth/cimd; client ID metadata documents; no dynamic client registration
  passkey(...)                 sign-in, as today
removed: bearer(), sessionHandoff
```

**Each client gets one grant type, and its registration is its ceiling.**

| Client | `client_id` | Grant | Redirect | Holds | Consent and target |
| --- | --- | --- | --- | --- | --- |
| A first-party app's browser build (Todos, Whispering) | The app id, e.g. `so.epicenter.todos`; public, pre-registered | Authorization code with S256 PKCE; no `offline_access` | `https://<app origin>/auth/callback`, exact | One access token in `localStorage`, shared by the origin's tabs | Skipped; target `*` |
| The Epicenter desktop app | `so.epicenter`; public, pre-registered | Authorization code with PKCE and `offline_access` | `http://127.0.0.1:<any port>/callback`, port ignored | Refresh token in the OS keychain; access tokens in the Bun host's memory; WebViews hold none ([ADR-0155](0155-epicenter-desktop-auth-is-one-credential-free-window-bun-authority.md)) | Skipped; target `*` |
| The `epicenter` CLI and agents on the person's machine | `so.epicenter.cli`; public, pre-registered; the only client allowed the device grant | Device authorization (RFC 8628) only | None | Refresh token in the OS keychain | Device approval page, every time |
| A third-party MCP client | The HTTPS URL of its client ID metadata document | Authorization code with PKCE and `offline_access` | Exactly those its document lists; loopback port ignored | Its own storage | Consent page, every time; reaches only the MCP resource ([ADR-0550](0550-epicenters-mcp-server-reaches-hosted-folders-through-grants-that-target-namespaces.md)) |

An installed app ([ADR-0540](0540-an-app-is-installed-by-building-its-source-and-approving-a-commit-trusts-it-fully.md))
is not a client: it runs in Epicenter's origin and uses the desktop app's grant
through the host's broker. First-party clients and the resources are seeded by
migrations, not by an admin session.

**Every resource accepts only opaque, hashed, audience-bound access tokens.**

| Resource (`resource`, the token's audience) | Serves | `allowedScopes` |
| --- | --- | --- |
| `https://api.epicenter.so` | `/v1/*` inference and transcription, `GET /api/repos`, the profile and usage reads | `ai`, `profile`, `folders:read` |
| `https://git.epicenter.so` | Git smart HTTP and LFS ([ADR-0546](0546-a-folder-syncs-to-git-epicenter-so-under-its-owners-namespace-and-the-first-push-creates-it.md), [ADR-0544](0544-a-blob-is-a-file-in-its-folder-and-git-decides-how-it-travels.md)) | `folders:read`, `folders:write` |
| `https://mcp.epicenter.so/mcp` | The folder MCP server (ADR-0550) | `folders:read`, `folders:write` |

**Every client's access tokens last eight hours, GitHub's lifetime for user
tokens, and a refresh token lapses after 30 days unused.** The lifetime is
`accessTokenTtl` on each `oauthResource` row. Every request checks the token in
the database, so a revocation is immediate, and the lifetime only bounds a
theft nobody notices.

The store keeps a SHA-256 hash of each token, never the token. A token is
checked by one SQL statement, which a revocation affects on the very next
request:

```sql
select t."userId", m.role
from "oauthAccessToken" t
join namespace_member m on m.account_id = t."userId" and m.namespace_id = $4
left join "session" s on s.id = t."sessionId"
where t.token = $1                                -- SHA-256 of the presented token
  and t.revoked is null and t."expiresAt" > now()
  and t.resources ? $2                            -- this resource's audience
  and t.scopes ? $3                               -- the scope the operation needs
  and t."referenceId" in ('*', 'ns:' || $4)       -- the grant's target
  and (t."sessionId" is null or s."expiresAt" > now());
```

A resource answers a missing or wrong-audience token with 401 and
`WWW-Authenticate: Bearer resource_metadata="..."`, and a missing scope with
403 `insufficient_scope`. Git accepts the token as the Basic password with
any username, or as a Bearer token.

**Scopes are `folders:read`, `folders:write`, `ai`, and `profile`, plus
`openid` and `offline_access`.**

| Scope | Allows |
| --- | --- |
| `folders:read` | Fetch, clone, LFS download, `GET /api/repos`, MCP read tools |
| `folders:write` | Push, push-to-create, LFS upload, MCP `write_files` |
| `ai` | `/v1/*` inference and transcription |
| `profile` | Reading the person's name, email, plan, and usage; it changes nothing |

A scope exists only while some route refuses a token without it. No scope
changes the account: linking a provider, deleting the account, and billing
happen only on the authorization server's own pages, with its session cookie.

**A grant targets `*` or one namespace, `ns:<id>`
([ADR-0547](0547-every-repository-has-one-owner-namespace-and-a-person-is-a-namespace-of-one.md)).**
`*` is every namespace the person is a member of, now and later. The person
picks the target on the consent page or the device approval page from "All
folders", "Personal", and each group by its title. `postLogin.consentReferenceId`
stores it on the consent, and every token copies it as `referenceId`; a device
grant's tokens receive it from the approval. A first-party app gets `*` without
a prompt. Membership is never copied into a token: removing a member stops
that member's tokens at the next request.

**A refresh family is one grant's lineage.** Refresh tokens rotate on every
use. A replay inside `refreshTokenReuseInterval` (60 seconds) receives the
cached response; a later replay revokes that lineage and nothing else. The
lineage is the refresh row's `authorizationCodeId`, stamped `device:<id>` for a
device grant. A Bun patch of `@better-auth/oauth-provider`, listed in the root
`package.json` `patchedDependencies` and submitted upstream, makes
reuse detection and revocation key on it instead of `(clientId, userId)`. A
refresh row without a lineage is an error, never a widening to the client's
family. Each installation refreshes one request at a time: the desktop's Bun
host in process, the CLI and `epicenter git-credential` under a file lock
beside the stored refresh token, which they reread inside the lock. A refresh
answered `invalid_grant` is retried once. A grant with `offline_access` has
its `sessionId` cleared at issuance, so it outlives the browser session that
approved it.

**A browser app keeps its access token in `localStorage` and holds no refresh
token.** The token is one per app origin, shared by that origin's tabs, and
survives a reload. Every browser storage is equally readable by script on the
origin (RFC 10017), so `localStorage` adds no exposure and spares each new tab
and reload a renewal redirect. When the access token is missing or within ten
minutes of expiry, the app navigates top level to
`/auth/oauth2/authorize` with `prompt=none`. While the authorization server's
session cookie exists, that returns a code without a page; otherwise it
answers `login_required` and the app shows sign-in. There is no hidden iframe:
the cookie is `SameSite=Lax`. Work held only in page memory, such as a browser
recording ([ADR-0543](0543-a-recording-streams-into-its-folder-from-the-moment-it-starts.md)),
is lost to that navigation.

**The authorization server's session cookie works only on its own pages.**
It is `HttpOnly` and host-only on `api.epicenter.so`, and these pages are its
only use: sign-in, consent, device approval, and account management (linking a
provider, adding or deleting a passkey, deleting the account, billing, and the
list of devices and grants, where each grant is revoked). No access token
reaches an account-management route. Freshness for those changes is
[ADR-0356](0356-sensitive-account-changes-use-better-auth-session-freshness.md).
Signing out deletes the access tokens issued under that session.

**`epicenter git-credential` serves Git short-lived tokens.** It answers
`git.epicenter.so` with a `git.epicenter.so`-audience access token minted from
the CLI's refresh token, with `password_expiry_utc`, and reuses it until five
minutes before expiry. The desktop shell registers the same helper for its
`git` runs.

**Self-host runs the same authorization server.** `apps/self-host/server.ts`
composes the same `createAuth` on Bun against plain Postgres. Its issuer and
resources are its own origin, fixed by the build
([ADR-0326](0326-the-deployment-names-the-authority-and-a-person-never-types-one.md)).

**Deleted by this decision:**

```txt
packages/server/src/auth/session-handoff.ts            and its tests
packages/auth/src/session-handoff-client.ts            and its test
bearer({ requireSignature: true })                     a session is no resource credential
packages/server/src/self-host-auth/                    the second owner of the handoff wire
apps/self-host/worker/                                 the SelfHostAuthOwner Durable Object entry
packages/server/src/auth/instance-token.ts             and packages/auth/src/instance-token.ts
apps/self-host/scripts/gen-token.ts
POST /api/git/connect                                  and its hourly tokens (ADR-0546)
planned: Better Auth's core deviceAuthorization(), its API key package, a session as a Git credential
```

**Operations:** the authorization server's Hyperdrive configuration has
caching disabled, so a revocation is not served stale. Resources are seeded at
migration with `resourceSeedMode: "insertOnly"`. The CIMD cache is
module-level, so it outlives a request. The token endpoint keeps Better
Auth's default rate limit.

## Consequences

- Every resource has one credential kind and one check. A credential held by an
  app, the CLI, an agent, or a third party reaches one audience, its scopes, and
  its target, and cannot change sign-in methods, delete the account, or spend
  through billing.
- Each request costs one indexed query, as `getSession` costs today, without
  its daily renewal write. Git, LFS, and MCP already join membership on that
  query (ADR-0547).
- A browser app redirects through the authorization server about once every
  eight hours while open, once for all of its tabs. A browser recording in progress at that moment is lost.
- A process that dies after the server rotates its refresh token and before it
  writes the new one has 60 seconds to replay; after that its installation signs
  in again. No other installation is affected.
- The patch is re-verified on every Better Auth upgrade until upstream takes it.
- Added tables: `oauthClient`, `oauthResource`, `oauthClientResource`,
  `oauthRefreshToken`, `oauthAccessToken`, `oauthConsent`,
  `oauthClientAssertion`, `deviceCode`. Expired tokens need a scheduled delete.
  `session-handoff.postgres.test.ts`'s assertion that no `oauth` tables exist
  goes with it.
- A device code is a phishing lure. The approval page shows the client, the
  requested scopes, the target, the requesting address, and "Only approve a
  code you just started."
- Self-hosters lose the Cloudflare deployment and need Postgres.
- Not verified by the spike: real Hyperdrive pooling, a production CIMD fetch
  on Workers (`fetch(url, { redirect: "manual" })` under
  `global_fetch_strictly_public`), Claude and ChatGPT end to end, and load.

## Considered alternatives

- **Better Auth session bearers for every client (ADR-0354, deleted).** Every
  session carries full account authority, MCP clients cannot use one, and a
  session in Git's helper output can delete the account.
- **Sessions for first-party clients, an authorization server for MCP, and an
  HMAC Git token derived from a session.** Three credential kinds from two
  issuers at the resources, and first-party sessions keep full account
  authority.
- **JWT access tokens.** They save a query only on routes that make no other
  query, at the cost of JWKS, key rotation, and revocation that waits for
  expiry.
- **`@cloudflare/workers-oauth-provider`.** No device grant, tokens in KV with
  about 60 seconds of propagation, and no Bun or Postgres for self-host.
- **One client row per installation**, to isolate refresh families. Creating a
  client needs a session, and headless device login would need a registration
  endpoint.
- **A hooks plugin for lineage.** A second reuse detector running before the
  library's, and a device lineage stamped after issuance by a separate write.
- **Browser refresh tokens with a Web Locks single flight.** A 30-day secret
  in `localStorage` and the cross-tab race of 2026-08.
- **A browser access token in `sessionStorage`.** Script on the origin reads
  it as easily (RFC 10017), and every new tab redirects to get its own.
- **Shorter access tokens, or a lifetime per client.** Revocation is already
  immediate at the next request, so a shorter lifetime only adds renewals,
  such as an hourly redirect in every browser app.
- **A writable `account` scope.** A token that can link providers, delete the
  account, or spend through billing is the session authority this record
  removes from clients; those changes stay on the authorization server's pages.
- **`prompt=none` in a hidden iframe.** The `SameSite=Lax` cookie is not sent
  in a cross-site frame.
- **Loopback login for the CLI.** A second CLI flow beside the device grant,
  which works on every machine, including over SSH.
- **Better Auth's API key package for agents.** A fourth credential kind; an
  agent gets its own device grant with a narrower scope and target.
- **Dynamic client registration.** The MCP specification deprecates it for
  CIMD, and Claude and ChatGPT both use CIMD.
- **Token exchange (RFC 8693) to narrow a token for an agent.** Better Auth has
  no such grant, and narrowing `scope` on refresh narrows the stored grant
  permanently.
