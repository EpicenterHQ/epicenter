# 0871. A public address signs people in with a passkey and connectors in with OAuth

- **Status:** Accepted
- **Date:** 2026-11-11
- **Amended by:** [ADR-0881](0881-people-reach-an-epicenter-over-the-tailnet-and-its-public-address-serves-only-connectors.md), which withdraws how people sign in (passkeys, invites, sessions, `/.sign-in`), the UIs and launcher on the public address, where a connector is approved, the `public` and `publicPort` fields, and revoking a person.
- **Relates:** [ADR-0864](0864-epicenter-is-a-data-server-for-repositories-of-files-and-code-runs-where-its-owner-trusts-it.md) (one public address, with OAuth), [ADR-0868](0868-an-epicenter-is-any-folder-that-says-it-is-one-and-a-computer-runs-as-many-as-it-has.md) (`EPICENTER.md`, a port per Epicenter), [ADR-0870](0870-an-apps-secrets-are-local-files-and-a-local-file-never-leaves-its-computer.md) (`.local` files), [ADR-0850](0850-an-action-changes-files-and-whoever-knows-the-intent-commits-them.md) (`readOnlyHint`, which the `read` scope follows), [ADR-0860](0860-an-interface-is-a-view-over-an-apps-actions-and-never-knows-where-they-run.md) (views at `/<app>/`).
- **Unbuilt:** nothing in code (`packages/cli/src/authorization-server.ts`, `public.ts`, `sign-in-pages.ts`, `access.ts`, `http.ts`). Not yet run live: WebAuthn in a real browser, a claude.ai or ChatGPT connection, and whether Funnel and Cloudflare send the headers the private listener refuses and the forwarded address rate limits key on.

## Context

Claude.ai (web, phone, and Desktop's "Add custom connector") and ChatGPT's
connectors reach an MCP server from their companies' servers. The server needs
a public HTTPS address, and MCP's authorization spec asks for OAuth 2.1 there.
`epicenter serve` has neither: it trusts every request, because only this
computer and the owner's tailnet reach it.

A first version of this record signed the owner in by Tailscale identity:
Funnel strips client-sent `Tailscale-User-*` headers, so a request carrying
one came from the tailnet. That made the sign-in work only through Funnel and
only for people on a tailnet. An Epicenter should be reachable through any
HTTPS tunnel, and a person should be able to approve a connector from any
browser.

Better Auth 1.8.0-beta.7 provides the pieces, checked by running the whole flow
in one process on 2026-11-11:

- `@better-auth/mcp`: `@better-auth/oauth-provider` set up for MCP. It gives
  PKCE, refresh-token rotation, scopes, access tokens bound to a `resource`,
  the RFC 9728 and RFC 8414 metadata, and `createMcpProtectedRequestHandler`.
  It needs the `jwt()` plugin and a database, and it redirects to a login page
  and a consent page that the server provides.
- `@better-auth/cimd`: Client ID Metadata Documents under the `mcp-2026-07-28`
  profile, which Claude and ChatGPT both document and prefer. Dynamic client
  registration stays off unless enabled.
- `@better-auth/passkey`: WebAuthn registration and sign-in. Its registration
  can start without a session (`requireSession: false`), resolving the user
  from a token the server issued.
- A `bun:sqlite` database works directly, and its tables are created from code
  at startup (`getMigrations(...).runMigrations()`), with no CLI step.

## Decision

**An Epicenter with a `public` address in `EPICENTER.md` opens a second
listener, and every request on it carries a person's session or a connector's
token.**

```md
---
port: 4747
public: https://studio.tail0f84e1.ts.net:10000/
publicPort: 4757
---
```

| Listener | Reached by | Trusts |
| --- | --- | --- |
| `127.0.0.1:<port>` | this computer; the tailnet through `tailscale serve` | every request whose `Host` is a loopback name, an IP literal, or a `*.ts.net` name, and that carries no tunnel header |
| `127.0.0.1:<publicPort>` | the internet, through a tunnel to `public` | a person's session, or a connector's bearer token |

The boundary is the socket a request arrives on, not a header on it. `serve`
never changes a tunnel's settings. The supported tunnels are Tailscale Funnel
and Cloudflare Tunnel, forwarding `public` to `127.0.0.1:<publicPort>`; any
other must target `publicPort` too. When `public` is set, `serve` prints the
public address and the port the tunnel must target, and refuses a non-loopback
`--host`.

**The private listener refuses what it can recognize as not private.** A
tunnel aimed at the wrong port, or a DNS rebinding page, would otherwise reach
a listener that trusts everything. So it answers only a `Host` that is a
loopback name, an IP literal, or a `*.ts.net` name (Tailscale controls that
DNS), and refuses any request carrying `Tailscale-Funnel-Request` or
`Cf-Connecting-IP`. Those headers, not `Host`, are what stops a supported
tunnel aimed at the wrong port. Funnel sets its header on every request and
deletes a copy the client sent, and Cloudflare Tunnel sets its own, so neither
delivers a request without one. Tailscale picks the route by the TLS server
name and forwards the client's `Host`, so a request through Funnel can name
`127.0.0.1`; a rule on `Host` stops only an honest browser. The Funnel behavior
is read from Tailscale's source (`ipn/ipnlocal/serve.go`) and is confirmed on
the live Funnel during setup.

**On the public listener:**

| Path | Needs |
| --- | --- |
| `GET /.well-known/oauth-protected-resource` | nothing: RFC 9728 metadata |
| `GET /.well-known/oauth-authorization-server/.auth` | nothing: RFC 8414 metadata |
| `/.auth/*` | Better Auth: authorize, token, consent, revoke, JWKS, passkey; nothing else is enabled |
| `GET /.sign-in` | nothing: a page that signs a person in with a passkey, or registers one from an invite |
| `GET /.allow` | a session: a page that approves a connector |
| `POST /` | a bearer token, or a session with this address as `Origin`; MCP |
| `GET /`, `/<app>/…` | a session; without one, a redirect to `/.sign-in` |

Every path of `serve`'s own starts with `.`, which no app name can (ADR-0864).
`POST /` without either answers 401 with the RFC 9728 challenge, naming only
`resource_metadata`, so a client chooses its scopes from the metadata.

**Better Auth is the authorization server, set up by `serve`:**

```ts
betterAuth({
  baseURL: publicOrigin,               // https://studio.tail0f84e1.ts.net:10000
  basePath: '/.auth',                  // issuer: <publicOrigin>/.auth
  secret: readOrCreate('access.local.key'),
  database: new Database(join(epicenterFolder, 'access.local.sqlite')), // WAL
  plugins: [
    jwt(),
    passkey({ rpID: publicHost, registration: { requireSession: false, resolveUser, afterVerification } }),
    mcp({
      resource: publicAddress,         // with the trailing slash, matched exactly
      loginPage: '/.sign-in',
      consentPage: '/.allow',
      scopes: ['read', 'write', 'offline_access'],
      accessTokenExpiresIn: 15 * 60,
    }),
    cimd({ fetchClientMetadataResource, metadataProfile: 'mcp-2026-07-28' }),
  ],
});
```

`access.local.sqlite` and `access.local.key` sit in the Epicenter's folder
beside `EPICENTER.md`. They are `.local`, so nothing commits them (ADR-0870),
and the computer's own backup keeps them. `POST /` checks a token with
`createMcpProtectedRequestHandler`, with the resource as its audience and the
signing keys read from the database, so a check never leaves the computer. The
authorization server metadata names no introspection endpoint.

**People sign in with passkeys, starting from an invite.** `epicenter access
invite` prints a link to `/.sign-in?invite=<token>` that works once, within 15
minutes. Opening it registers a passkey on that device and signs the person
in; the passkey is the account, and there is no password or email. Each device
without a synced passkey takes its own invite. A signed-in person can do
everything, on every device, until the session ends after 7 days.

**Connectors sign in with OAuth and identify themselves by CIMD.**

1. In claude.ai: Settings, Connectors, "Add custom connector", and paste
   `public`. In ChatGPT: the same, under developer mode.
2. The browser opens `/.sign-in`, which asks for a passkey every time.
3. `/.allow` leads with the host serving the connector's client_id
   (`claude.ai`), shows the whole client_id, then the name its CIMD document
   gives itself, and says to allow it only for a connection the person just
   started. Its buttons are "Allow reading and changing" and "Allow reading
   only". Text from the document is shown without control or bidirectional
   characters.
4. The connector receives a 15-minute access token and a refresh token.

Every authorization asks for a passkey and shows `/.allow`, whatever the
connector asked: the router sets `prompt=login consent`. Better Auth otherwise
finishes an authorization silently when a consent is stored, so a page the
owner visits could start one for an attacker's own claude.ai account and land
a grant there.

**Two scopes, plus `offline_access`.** `read` lists and calls only actions with
`readOnlyHint: true`, each in a child started to refuse every command and
any other action (`packages/cli/src/child.ts`). The router does not read the
call; a call to any other action gets the child's refusal as a tool error. A
token without `read` gets 403 with an `insufficient_scope` challenge. A
read-only call
commits nothing, and takes its app's lock only to write a `.local` file, as
any write does (ADR-0850). `write` allows every action.
The router adds `offline_access` to every authorization and refuses an
approval without it, so every code exchange starts a refresh family, which the
generation rule below can check. Better Auth lets any connector allowed the
authorization code grant refresh, whatever its document lists. A token's scope
is fixed at approval. Approving a grant again with narrower scopes deletes its
refresh families that hold more.

**Access is listed and revoked from the command line:**

```txt
epicenter access                                people and grants
epicenter access invite [<name>]                a link that registers one passkey, once, within 15 minutes
epicenter access revoke <person>                their passkeys, sessions, user, and every grant they made
epicenter access revoke <connector>             every grant of that connector
epicenter access revoke <connector> <person>    that one grant
```

**A grant is a connector one person approved.** A client_id does not identify
who holds a grant: one connector serves many accounts. So access is listed and
revoked per (connector, person), and each grant shows its live refresh
families, so a second connection under one approval is visible.

**A revoke ends a grant at once, including what is in flight.** Deleting rows
is not enough: Better Auth's refresh does not check consent, and a code
exchange or rotation paused across a revoke would write a new refresh row
after it. Epicenter keeps two tables of its own in `access.local.sqlite`:
`grantRevocation` (a row per grant a revoke ends) and `codeIssued` (each
authorization code with its issue time from SQLite's clock, in milliseconds).
SQL triggers on Better Auth's tables, recreated after its migrations on every
start, enforce:

- an authorization code inserts only while its grant has a consent;
- a refresh token inserts only while its grant has a consent and only from a
  code issued after the grant's last revoke; otherwise the token endpoint
  answers 400 `invalid_grant` with no token;
- after a JWT verifies, every MCP call needs a consent covering its scopes, a
  passkey for its person, and an issue second later than the grant's last
  revoke; otherwise 401 `invalid_token`.

A revoke also deletes the grant's consent, refresh tokens, access token
records, and pending codes, but correctness rests on the triggers, so a missed
row fails closed. Neither table is pruned: a family's `codeIssued` row is
needed for as long as it rotates. `POST /.auth/oauth2/revoke` is a connector's
own disconnect: it revokes the refresh token presented, not the grant.

## Consequences

- `packages/cli` depends on `better-auth`, `@better-auth/mcp`,
  `@better-auth/cimd`, and `@better-auth/passkey` at 1.8.0-beta.7 or later.
- Tailscale is optional. The tailnet still reaches the private listener with
  no sign-in. A phone off the tailnet reaches the UIs at `public` after a
  passkey, and the apps through Claude or ChatGPT.
- A passkey belongs to the public hostname. Moving to another tunnel or name
  means registering again from a new invite, and reapproving connectors.
- Browsers send cookies by hostname, not port, so the session cookie from
  `:10000` also goes to other services on the same hostname (`:443` on the
  Studio). They are the owner's own, tailnet-only routes; a dedicated hostname
  is the fix if that changes.
- `serve` ships its own CIMD fetch. Upstream `@better-auth/cimd/node` connects
  to the first DNS answer only; Bun lists IPv6 first, so fetching Claude's
  document fails on a network without IPv6. `serve`'s fetch keeps the upstream
  checks (public addresses only, the certificate checked against the name) and
  tries IPv4 first. It goes when upstream tries each address.
- Better Auth requires an email on a user; `serve` gives each person a
  placeholder at `epicenter.invalid`.
- Every request through a tunnel comes from `127.0.0.1`, so rate limits key on
  the tunnel's forwarded-address header. Tailscale overwrites it; Cloudflare's
  is checked during live setup.
- Accepted after an adversarial review by three independent reviewers, and
  not closed:
  - a revoke and a passkey re-approval of the same grant both landing between
    two awaited database writes of one in-flight request (milliseconds);
  - a tunnel other than Funnel or Cloudflare Tunnel, aimed at the private
    port, that adds no tunnel header and forwards an allowed `Host`; the
    private port is never tunneled;
  - `read` relies on each action's honest `readOnlyHint`;
  - invites are not listed or cancellable before they expire;
  - Better Auth's 30-second refresh reuse window;
  - views share the public origin with no content security policy, to revisit
    when a view renders data that a connector or agent can write.
- Anyone who learns the address reaches the sign-in and metadata paths. Nothing
  past them works without a passkey that an invite from this computer created.
- If ChatGPT cannot complete CIMD, the fix is enabling
  `allowDynamicClientRegistration` and `allowUnauthenticatedClientRegistration`;
  every approval still needs a person's passkey. Turning them on amends this
  record.

## Considered alternatives

- **Approval by tailnet identity (this record's first version).** No
  registration step, but it trusts headers only Funnel strips, so it ties the
  sign-in to Funnel, and approving needs a device on the tailnet.
- **`serve` probing its own public address.** The first build fetched
  `public` every 5 minutes and stopped the private listener when the answer
  came from it. The tunnel headers already refuse a supported tunnel aimed
  there, and the probe saw only the address in `EPICENTER.md`, so it caught
  only an unsupported tunnel at that one address, up to 5 minutes late. A
  collapse pass removed it, with the router's own check of each read call,
  which repeated the child's.
- **One listener that tells tunnel requests apart by header.** It depends on
  each tunnel adding and stripping the right headers. A second listener makes
  the boundary the socket, which no request can forge.
- **An authorization server written in `serve`.** About 300 lines and no
  dependencies, but Epicenter would own PKCE, rotation, audience binding, CIMD
  fetching with DNS pinning, and replay rules that Better Auth already tests.
- **The hosted Epicenter API as the authorization server.** `serve` would only
  check tokens against its keys. The home would depend on a hosted service to
  sign anyone in. A later option for people who want no tunnel.
- **Cloudflare Access in front of the tunnel.** No auth code, but Cloudflare
  ends TLS and reads every request, and it needs a Cloudflare account and a
  domain. Cloudflare Tunnel alone, in front of this sign-in, remains a choice.
- **Anthropic's MCP tunnels.** A research preview for Claude Enterprise
  organizations, and Claude only.
- **Allowlisting the vendors' IP ranges.** Any user of those services who
  learns the address gets in. Anthropic recommends OAuth instead.
- **Better Auth's state in `.local.md` files through a custom adapter.** The
  state is the server's bookkeeping: hashed tokens, signing keys, consents,
  and replay entries, changed on every sign-in and read by `epicenter access`
  at the same time. SQLite gives both processes atomic access, and Better
  Auth's adapters are tested on it.
- **Plain public HTTP or a forwarded router port.** OAuth requires HTTPS, and a
  forwarded port publishes the home's address.
