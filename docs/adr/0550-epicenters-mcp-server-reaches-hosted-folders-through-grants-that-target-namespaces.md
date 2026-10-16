# 0550. Epicenter's MCP server reaches hosted folders through grants that target namespaces

- **Status:** Accepted
- **Date:** 2026-10-15
- **Superseded by:** [ADR-0578](0578-epicenter-hosts-no-mcp-server.md): Epicenter hosts no MCP server; `mountMcpServer`, `hosted-repository.ts`, and the `mcp` audience are deleted.
- **Unbuilt:** routing `mcp.epicenter.so` to the Worker, `write_files` against the Artifacts store, and Claude and ChatGPT end to end. The fetch cap counts a folder's whole history, committed recordings included, until LFS ([ADR-0544](0544-a-blob-is-a-file-in-its-folder-and-git-decides-how-it-travels.md)) moves blobs out of it. Built: `mountMcpServer` (`packages/server/src/routes/mcp.ts`) on both entries, its Protected Resource Metadata, the six tools, and `write_files`' commit through the `GitHost` store, which copies the repository into memory with isomorphic-git on every call and refuses a repository whose fetch is larger than 8 MiB (`MAX_FETCH_BYTES` in `packages/server/src/hosted-repository.ts`); verified on Bun with the disk store and an MCP SDK client.

## Context

A person's hosted folders are Git repositories at
`git.epicenter.so/<namespace>/<name>.git`
([ADR-0546](0546-a-folder-syncs-to-git-epicenter-so-under-its-owners-namespace-and-the-first-push-creates-it.md)).
An agent on the person's machine reaches them with `git` and
`epicenter git-credential`. Claude, ChatGPT, and other MCP clients run
elsewhere and have no `git`; they reach data through MCP tools. The MCP
authorization specification of 2026-07-28 requires the server to publish RFC
9728 Protected Resource Metadata, to accept only tokens issued for its own
audience, and never to pass a client's token upstream.
[ADR-0549](0549-every-epicenter-resource-accepts-only-opaque-access-tokens-from-one-oauth-authorization-server.md)
makes Epicenter the authorization server these clients use, through client ID
metadata documents and a consent page that picks scopes and a target.

## Decision

**Epicenter hosts an MCP server for folders at `https://mcp.epicenter.so/mcp`,
and it accepts only access tokens whose audience is that URL.**

```txt
GET  https://mcp.epicenter.so/.well-known/oauth-protected-resource/mcp
     { resource: "https://mcp.epicenter.so/mcp",
       authorization_servers: ["https://api.epicenter.so"],
       scopes_supported: ["folders:read", "folders:write"] }
401  WWW-Authenticate: Bearer resource_metadata="https://mcp.epicenter.so/.well-known/oauth-protected-resource/mcp"
403  WWW-Authenticate: Bearer error="insufficient_scope", scope="folders:read folders:write", resource_metadata="..."
```

The authorization server's metadata advertises
`client_id_metadata_document_supported: true` and `none` among
`token_endpoint_auth_methods_supported`, which Claude requires before it uses a
metadata document. `offline_access` appears in neither the resource metadata
nor a challenge.

**Every tool call is allowed by three facts, checked in ADR-0549's one
statement:** the token holds the tool's scope, the grant's target is `*` or
the repository's namespace, and the person's role in that namespace allows the
operation ([ADR-0547](0547-every-repository-has-one-owner-namespace-and-a-person-is-a-namespace-of-one.md)).

| Tool | Scope | Role operation | Answers |
| --- | --- | --- | --- |
| `list_folders` | `folders:read` | read | The repositories in the grant's target, grouped as "Personal" or by group title |
| `describe_folder` | `folders:read` | read | The folder's `epicenter.json` as published (its declaration), its head commit, and its file count |
| `list_files` | `folders:read` | read | Paths under a prefix, at a commit (the head by default) |
| `read_files` | `folders:read` | read | The content of each path; an LFS file as its pointer and size, never its bytes |
| `write_files` | `folders:write` | push | One commit from `{ base, message, changes }`, where each change is `{ path, content }` or `{ path, delete: true }` |
| `history` | `folders:read` | read | The commits that touch a path |

Each tool takes `namespace` and `name`, the two segments of the remote URL, and
every answer names the commit it read or made. Read tools carry the
`readOnlyHint` annotation.

**`write_files` makes one commit and is refused when its `base` is not the
current head.** The refusal names the current head; the server merges nothing.
A client reads again and writes again. Merging edits from two writers is the
folder's one write path on a person's devices
([ADR-0548](0548-a-view-is-a-cache-of-files-with-one-write-path-one-read-path-and-one-channel-of-change.md)),
which the next Sync of each device runs. What `write_files` commits is data
from outside, like a push from any device: an app's trust does not extend to
it ([ADR-0540](0540-an-app-is-installed-by-building-its-source-and-approving-a-commit-trusts-it-fully.md)).

**The server reaches storage as itself.** It reads and commits through the
`GitHost` store of ADR-0546 with the store's own token; a client's token never
leaves the MCP server.

**There are no tools that delete, rename, or move a repository, or that change
members.** Those stay on the authorization server's account pages and in the
Folders window.

## Consequences

- A person connects Claude or ChatGPT by adding `https://mcp.epicenter.so/mcp`,
  signing in, and choosing "Read your folders" or "Read and edit your folders"
  and a target; the authorization server's account pages list the connection
  and revoke it.
- A third-party client reaches folders and nothing else: no AI spending, no
  profile reads, no Git.
- Each tool call costs the token query, plus the store's reads or one commit.
- A client that lacks `folders:write` receives a 403 naming both scopes and
  can ask the person to step up.
- A connection whose client used one CIMD `client_id` on several machines
  shares one refresh lineage per authorization; a replay after 60 seconds ends
  that authorization, and the person connects again.

## Considered alternatives

- **`@better-auth/mcp`.** It configures one resource and cannot be combined
  with an `oauthProvider` that also serves the API and Git.
- **Git audience tokens for third-party clients.** MCP clients do not run
  `git`, and a Git token for a third party is a second path to the same data.
- **A server-side merge for a stale `base`.** A second merge beside the
  devices' write path, run where no person can see a conflict.
- **Scopes per namespace (`folders:write:<id>`).** The target already narrows
  a grant, and the MCP specification asks `scopes_supported` to be a small
  baseline.
