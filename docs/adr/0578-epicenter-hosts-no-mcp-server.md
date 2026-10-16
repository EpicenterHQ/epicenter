# 0578. Epicenter hosts no MCP server

- **Status:** Accepted
- **Date:** 2026-10-16
- **Supersedes:** [ADR-0550](0550-epicenters-mcp-server-reaches-hosted-folders-through-grants-that-target-namespaces.md), whose folder MCP server at `https://mcp.epicenter.so/mcp` is deleted.
- **Amends:** [ADR-0549](0549-every-epicenter-resource-accepts-only-opaque-access-tokens-from-one-oauth-authorization-server.md) at the third-party MCP client row, the `https://mcp.epicenter.so/mcp` resource row, the MCP uses of `folders:read` and `folders:write`, and `cimd(...)`: there is no `mcp` audience, and no client identifies itself by a client ID metadata document. [ADR-0565](0565-a-refresh-token-keeps-its-grants-scopes-and-only-each-access-token-is-narrowed-to-its-audience.md) at "only `mcp` limits scopes" and the `mcp` column of its audience table: a deployment has two audiences, `api` and `git`, and both allow every scope.

## Context

ADR-0550 put an MCP server in front of hosted folders so that Claude.ai and
ChatGPT, which run elsewhere and have no `git`, could read and commit to a
person's repositories. Building it took:

```txt
packages/server/src/routes/mcp.ts             mountMcpServer, six tools
packages/server/src/hosted-repository.ts      an in-memory isomorphic-git copy of a repository per call
packages/server/workers/                      a workerd test harness for that copy
packages/server/src/auth/client-metadata-fetch.ts, @better-auth/cimd
                                              client ID metadata documents for third-party clients
resolveOAuthAudiences(...).mcp                a third audience, with its own scope ceiling
```

The tool calls copy the whole repository into memory each time and refuse a
repository over 8 MiB, so a folder with committed recordings could not be
served. The Artifacts path never ran, and `mcp.epicenter.so` was never routed.

The people Epicenter serves reach their folders two other ways. An agent on
their machine has the folder's files, system `git`, and the `epicenter` CLI. A
person on a phone uses the browser apps, which fetch and push to hosted Git
themselves (ADR-0546).

## Decision

**Epicenter hosts no MCP server.** An agent works on a folder through its
files, `git`, and the `epicenter` CLI on the machine it runs on. Chat access
from Claude.ai or ChatGPT to hosted folders is given up.

**A deployment has two token audiences, `api` and `git`.**
`resolveOAuthAudiences` in `packages/constants/src/apps.ts` returns
`{ api, git }`; `OAuthAudiences` in `packages/server/src/auth/oauth-policy.ts`
names the same two. Each allows every scope in `OAUTH_SCOPES`.

**Every OAuth client is a first-party row written by
`registerFirstPartyClients`.** The authorization server composes no
`@better-auth/cimd` plugin, keeps `allowDynamicClientRegistration: false`, and
sets no `clientRegistrationDefaultResources`. A `client_id` that names a URL is
an unknown client: `/auth/oauth2/authorize` answers `invalid_client`.
`createCloudContextMiddleware` takes `oauthServer: true` instead of a
metadata-document transport.

What stays, and who uses it:

| Piece | Kept for |
| --- | --- |
| `/consent` page and `grant-target.ts` | `so.epicenter.cli`, whose device codes are approved there with a folder choice |
| `/.well-known/oauth-protected-resource` | standards conformance: RFC 9728 metadata for the `api` and `git` audiences, which their 401 and 403 name in `resource_metadata`. No first-party client reads it today |
| `offline-detach.ts` | the desktop app's and the CLI's refresh tokens |

## Consequences

Deleted: `mountMcpServer` and `packages/server/src/routes/mcp.ts`,
`hosted-repository.ts`, their tests, the `workers/` harness with its
`test:workers` script and `vitest`, `@cloudflare/vitest-pool-workers`, and
`miniflare`; `client-metadata-fetch.ts`, `nodeClientMetadataFetch`, and
`@better-auth/cimd`; `@modelcontextprotocol/sdk` and the runtime
`isomorphic-git` in `@epicenter/server` (a Git test still uses it). The
`global_fetch_strictly_public` flag in `apps/api/wrangler.jsonc`, added for
metadata-document fetches, stays: it keeps every outbound Worker fetch on the
public internet.

An `oauth_resource` row for an old `mcp` audience in an existing database is
inert: no route checks a token for it, and no client links to it.

A person who wants Claude.ai or ChatGPT to read a folder copies the text in, or
runs an agent locally. Bringing chat access back means a new record that also
answers how a large folder is served without copying it per call.

## Considered alternatives

- **Keep the server, route `mcp.epicenter.so`, and verify it on Artifacts.**
  The per-call copy and its 8 MiB cap stay, and committed audio exceeds that
  cap; a server for clients no first-party flow needs is upkeep with no user.
- **Keep CIMD for a later third-party client.** Every surface it opens (an
  outbound fetch to any URL, consent for unknown clients, a third audience)
  stays exposed for no caller.
