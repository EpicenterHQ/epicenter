# 0871. A public address signs people in with a passkey and connectors in with OAuth

- **Status:** Proposed
- **Date:** 2026-11-11
- **Relates:** [ADR-0864](0864-epicenter-is-a-data-server-for-repositories-of-files-and-code-runs-where-its-owner-trusts-it.md) (one public address, with OAuth), [ADR-0868](0868-an-epicenter-is-any-folder-that-says-it-is-one-and-a-computer-runs-as-many-as-it-has.md) (`EPICENTER.md`, a port per Epicenter), [ADR-0870](0870-an-apps-secrets-are-local-files-and-a-local-file-never-leaves-its-computer.md) (`.local` files), [ADR-0850](0850-an-action-changes-files-and-whoever-knows-the-intent-commits-them.md) (`readOnlyHint`, which the `read` scope follows), [ADR-0860](0860-an-interface-is-a-view-over-an-apps-actions-and-never-knows-where-they-run.md) (views at `/<app>/`).
- **Unbuilt:** all of it. Today `epicenter serve` listens on `127.0.0.1` only, signs no one in, and is reached through `tailscale serve` on the tailnet (`packages/cli/src/http.ts`).

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
| `127.0.0.1:<port>` | this computer; the tailnet through `tailscale serve` | everything, as today |
| `127.0.0.1:<publicPort>` | the internet, through a tunnel to `public` | a person's session, or a connector's bearer token |

The boundary is the socket a request arrives on, not a header on it. `serve`
never reads Tailscale headers and never changes a tunnel's settings: any HTTPS
tunnel that forwards `public` to `127.0.0.1:<publicPort>` works, such as
Tailscale Funnel or Cloudflare Tunnel. When `public` is set, `serve` prints the
public address and the port the tunnel must target.

**On the public listener:**

| Path | Needs |
| --- | --- |
| `GET /.well-known/oauth-protected-resource` | nothing: RFC 9728 metadata |
| `GET /.well-known/oauth-authorization-server/.auth` | nothing: RFC 8414 metadata |
| `/.auth/*` | Better Auth: authorize, token, consent, JWKS, passkey; nothing else is enabled |
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
signing keys read from the database, so a check never leaves the computer.

**People sign in with passkeys, starting from an invite.** `epicenter access
invite` prints a link to `/.sign-in?invite=<token>` that works once, within 15
minutes. Opening it registers a passkey on that device and signs the person
in; the passkey is the account, and there is no password or email. Each device
without a synced passkey takes its own invite. A signed-in person can do
everything, on every device, until the session ends after 7 days.

**Connectors sign in with OAuth and identify themselves by CIMD.**

1. In claude.ai: Settings, Connectors, "Add custom connector", and paste
   `public`. In ChatGPT: the same, under developer mode.
2. The browser opens `/.sign-in`, which asks for a passkey unless a session is
   live.
3. `/.allow` shows the connector's name and host from its CIMD document
   ("Claude, claude.ai") and two buttons: "Allow reading and changing" and
   "Allow reading only".
4. The connector receives a 15-minute access token and a refresh token.

**Two scopes, plus `offline_access`.** `read` lists and calls only actions with
`readOnlyHint: true`; a call to any other answers 403 with an
`insufficient_scope` challenge naming `write`. `write` allows every action.
Without `offline_access` Better Auth issues no refresh token, and a connector
would ask the person again every 15 minutes, so `/.allow` grants
`read offline_access` or `read write offline_access`. A token's scope is fixed
at approval; asking for `write` later shows `/.allow` again.

**Access is listed and revoked from the command line:**

```txt
epicenter access                      people (passkeys) and connectors: name, host, scope, approved, last used
epicenter access invite               a one-time link that registers a passkey
epicenter access revoke <name>        a connector: its consent and refresh tokens; a passkey: it and its sessions
```

Revoking a connector deletes its refresh tokens, not only its consent: the
refresh grant does not check consent. An access token it already holds works
until it expires, within 15 minutes.

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
  Studio). They are the owner's own.
- `serve` ships its own CIMD fetch. Upstream `@better-auth/cimd/node` connects
  to the first DNS answer only; Bun lists IPv6 first, so fetching Claude's
  document fails on a network without IPv6. `serve`'s fetch keeps the upstream
  checks (public addresses only, the certificate checked against the name) and
  tries IPv4 first. It goes when upstream tries each address.
- Better Auth requires an email on a user; `serve` gives each person a
  placeholder at `epicenter.invalid`.
- Every request through a tunnel comes from `127.0.0.1`, so rate limits key on
  the tunnel's forwarded-address header.
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
