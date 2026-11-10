# 0871. A public address signs clients in with Better Auth's MCP plugin, and the owner approves from the tailnet

- **Status:** Proposed
- **Date:** 2026-11-11
- **Relates:** [ADR-0864](0864-epicenter-is-a-data-server-for-repositories-of-files-and-code-runs-where-its-owner-trusts-it.md) (one public address through Funnel, with OAuth), [ADR-0868](0868-an-epicenter-is-any-folder-that-says-it-is-one-and-a-computer-runs-as-many-as-it-has.md) (`EPICENTER.md`, ports per Epicenter; its open sign-in is settled here), [ADR-0870](0870-an-apps-secrets-are-local-files-and-a-local-file-never-leaves-its-computer.md) (`.local` files), [ADR-0850](0850-an-action-changes-files-and-whoever-knows-the-intent-commits-them.md) (`readOnlyHint`, which the `read` scope follows).
- **Unbuilt:** all of it. Today `epicenter serve` listens on `127.0.0.1`, signs no one in, and is reached through `tailscale serve` on the tailnet only (`packages/cli/src/http.ts`).

## Context

Claude.ai (web, phone, and Desktop's "Add custom connector") and ChatGPT's
connectors reach an MCP server from their companies' servers. So the server
needs a public HTTPS address, and MCP's authorization spec asks for OAuth 2.1
on it. `epicenter serve` has neither, and ADR-0868 keeps it on the tailnet
until a sign-in exists. Anything that reaches it today can run every action of
every app.

Three facts set the shape. Each was checked on 2026-11-11.

- **Tailscale Funnel** (`ipn/ipnlocal/serve.go`):
  - It ends TLS on the computer itself, so its relays cannot read the
    traffic.
  - It allows only ports 443, 8443, and 10000.
  - It deletes any `Tailscale-User-*` header a client sends, on every
    request, so no client can claim a tailnet identity.
  - A request from the internet gets `Tailscale-Funnel-Request: ?1` and no
    identity.
  - A request from a tailnet user gets `Tailscale-User-Login`. A tagged node
    gets neither.
- **Better Auth** publishes `@better-auth/mcp` (1.8.0-beta.7). It is
  `@better-auth/oauth-provider` configured for MCP and provides:
  - PKCE, refresh tokens with rotation, and scopes;
  - access tokens bound to the configured `resource`;
  - both `/.well-known` metadata documents;
  - `requireMcpAuth`, which wraps a `(Request) => Response` handler.

  `@better-auth/cimd` adds Client ID Metadata Documents under the
  `mcp-2026-07-28` profile. Dynamic client registration is off unless enabled.
  The plugin needs the `jwt()` plugin, a database, a `loginPage`, and a
  `consentPage`. `packages/server` already runs `@better-auth/oauth-provider`
  for the hosted API.
- **Claude and ChatGPT** both document CIMD, and prefer it when the
  authorization server's metadata advertises
  `client_id_metadata_document_supported`. Both fall back to dynamic
  registration.

## Decision

**An Epicenter is public when its `EPICENTER.md` names a Funnel port, and
`serve` then signs clients in itself.** The front-matter field is `public`,
one of 443, 8443, or 10000:

```md
---
port: 4747
public: 10000
---
```

The public address is `https://<this computer's tailnet name>:<public>/`, for
example `https://studio.tail0f84e1.ts.net:10000/`. `serve` reads the name from
`tailscale status --json`. `serve` does not change Tailscale's settings. When
Funnel on that port does not route to it, `serve` says so and names the one
command, for example
`tailscale funnel --bg --https=10000 http://127.0.0.1:4747`.

**Who may ask is decided per request, from what Tailscale added:**

| A request that | carries | may |
| --- | --- | --- |
| came through Funnel | `Tailscale-Funnel-Request: ?1` and a bearer token | call actions its token's scope allows, at `POST /` only |
| came through Funnel | `Tailscale-Funnel-Request: ?1` and no token | reach only the sign-in paths below; `POST /` answers 401 with the RFC 9728 challenge |
| came over the tailnet | `Tailscale-User-Login` in `owners` | everything, with no token, as today |
| came over the tailnet | another `Tailscale-User-Login` | nothing: 403 |
| has no Tailscale header | (this computer, or a tagged node) | everything, as today |

`owners` in `EPICENTER.md` lists tailnet logins. When it is absent, the owner
is the login that owns this computer on the tailnet, from
`tailscale status --json`. Tagged nodes look like this computer, so the
tailnet's access rules keep them off the port (ADR-0868).

Over Funnel, `serve` answers only these paths; everything else, including the
launcher at `GET /` and each `/<app>/` UI, is 404:

```txt
POST /                                         MCP, through requireMcpAuth
GET  /.well-known/oauth-protected-resource     RFC 9728 metadata
GET  /.well-known/oauth-authorization-server   RFC 8414 metadata
     /.auth/*                                  Better Auth: authorize, token, jwks
GET  /.sign-in                                 the loginPage
GET  /.allow                                   the consentPage
```

Every path is one of `serve`'s own, starting with `.`, which no app name can
(ADR-0864).

**Better Auth is the authorization server, preconfigured by `serve`:**

```ts
betterAuth({
  baseURL: publicAddress,
  basePath: '/.auth',
  database: new Database(join(epicenterFolder, 'connections.local.sqlite')),
  plugins: [
    jwt(),
    mcp({
      resource: publicAddress,
      loginPage: '/.sign-in',
      consentPage: '/.allow',
      scopes: ['read', 'write'],
    }),
    cimd({ fetchClientMetadataResource, metadataProfile: 'mcp-2026-07-28' }),
    tailnetSignIn({ owners }),
  ],
});
```

`tailnetSignIn` is `serve`'s own plugin, a single endpoint. It answers a
request with an owner's `Tailscale-User-Login`, and no
`Tailscale-Funnel-Request`, by creating a session for the user named by that
login (`internalAdapter.createSession`). It then continues the authorization.
There is no password and no account to make. Dynamic client registration stays
off; clients identify themselves by CIMD.

**What a person does:**

1. Add `public: 10000` to `EPICENTER.md` and turn on Funnel with the command
   `serve` names.
2. In claude.ai: Settings, Connectors, "Add custom connector", and paste the
   address. In ChatGPT: the same, under developer mode.
3. The browser opens `/.sign-in` on the home. On a device on the tailnet it
   signs in without a prompt. `/.allow` then shows the client's name and host
   from its CIMD document ("Claude, claude.ai") and two buttons: "Allow
   reading and changing" and "Allow reading only".
4. From a browser off the tailnet, `/.sign-in` says "Open this on a device
   signed in to your tailnet to approve it." and approves nothing.

**Two scopes.** `read` lists and calls only actions with `readOnlyHint: true`.
A call to any other action answers 403 with an `insufficient_scope` challenge
naming `write`. `write` allows every action. A token's scope is fixed at
approval.

**Approvals are listed and revoked from the command line:**

```txt
epicenter connections                       each approved client: name, host, scope, approved, last used
epicenter connections revoke <client>       delete its consent and refresh tokens
```

An access token lives 15 minutes, so a revoke takes effect within 15 minutes.
`connections.local.sqlite` holds Better Auth's state: the owner's user row,
sessions, signing keys, clients, consents, and tokens. It sits in the
Epicenter's folder beside `EPICENTER.md`. It is `.local`, so it is never
committed (ADR-0870), and the computer's own backup keeps it.

## Consequences

- `packages/cli` depends on `better-auth`, `@better-auth/mcp`, and
  `@better-auth/cimd` at 1.8.0-beta.7 or later. The repo catalog moves there
  from 1.8.0-beta.0, which also moves `packages/server` and `apps/api`.
- Anyone who learns the address can reach the sign-in paths. Nothing past
  them works without an owner's approval, and approval needs the owner's
  tailnet login.
- Approving from a browser off the tailnet is not possible. A passkey
  registered while signed in from the tailnet (Better Auth's passkey plugin,
  already used by `apps/api`) is the later way to approve from anywhere.
- Revoking is not instant: an issued access token works until it expires.
- One computer has at most three public ports, and this Studio already uses
  443 for other routes. A second public Epicenter on it takes 8443. Two
  Epicenters cannot share a port by path, because OAuth discovery reads the
  metadata documents at the root.
- If a client cannot complete CIMD (one community report says ChatGPT
  sometimes registers dynamically even when CIMD is offered), the fix is
  enabling `allowDynamicClientRegistration` and
  `allowUnauthenticatedClientRegistration`. Any approval still needs the
  owner. Turning them on amends this record.
- The UIs stay on the tailnet. A phone off the tailnet reaches its apps
  through Claude or ChatGPT, not the browser.

## Considered alternatives

- **An authorization server written in `serve`.** About 300 lines and no
  dependencies, but Epicenter would own PKCE, rotation, audience binding,
  CIMD fetching with DNS pinning, and replay rules that Better Auth already
  tests.
- **The hosted Epicenter API as the authorization server.** `serve` would
  only check tokens against its JWKS (`createMcpProtectedRequestHandler`).
  It is the easiest setup for people without Tailscale, but your home would
  depend on a hosted service to issue tokens, and the hosted server registers
  no third-party clients today. It is a later option for other people's
  Epicenters.
- **Cloudflare Tunnel with Access managed OAuth.** No auth code, but
  Cloudflare ends TLS and reads every request, and it needs a Cloudflare
  account and a domain.
- **Anthropic's MCP tunnels.** A research preview for Claude Enterprise
  organizations, and Claude only.
- **Allowlisting the vendors' IP ranges.** Any user of those services who
  learns the address gets in. Anthropic recommends OAuth instead.
- **A passkey as the only approval.** It works off the tailnet, but needs a
  registration step before the first connector. Tailnet identity needs none.
- **Better Auth's state in `.local.md` files through a custom adapter.** The
  state is the server's own bookkeeping: hashed tokens, signing keys,
  consents, and replay entries. `serve` changes it on every sign-in, and the
  command line reads it concurrently. SQLite gives both processes atomic
  access, and it is what Better Auth's adapters are tested on. A person reads
  it through `epicenter connections`, not the file.
- **Plain public HTTP or a forwarded router port.** OAuth requires HTTPS, and
  a forwarded port publishes the home's address.
