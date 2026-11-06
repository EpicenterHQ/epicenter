# 0800. A store's wire speaks HTTP's conditional requests, and apps connect agents to the CLI

- **Status:** Accepted (2026-11-05)
- **Date:** 2026-11-05
- **Amends:** [ADR-0798](0798-a-store-patches-fields-and-writes-text-and-a-change-is-data.md) at "Each place keeps its own transport": a store reached over HTTP reads and writes one file as HTTP does; [ADR-0799](0799-a-folders-contract-is-also-an-mcp-server.md) at how an agent reaches `epicenter mcp`: an app connects it when a person asks.
- **Relates:** [ADR-0762](0762-epicenter-is-made-of-standards-and-places.md) (speak the standard), [ADR-0784](0784-whispering-is-the-webs-local-app-and-messages-is-a-program-on-this-computer.md) (Messages' served store), [ADR-0793](0793-programs-only-compose-typescript-holds-what-epicenter-means-and-rust-holds-the-os-git-and-secrets.md) (the CLI is its own program), [ADR-0750](0750-sync-is-like-save-any-program-can-sync-a-folder-and-none-owns-it.md) (no background service).
- **Amended by:** [ADR-0807](0807-an-app-writes-only-to-a-local-store-and-only-sync-talks-to-a-server.md) at the server's single-file routes: there are none; a served store keeps that shape.
- **Amended by:** [ADR-0816](0816-the-epicenter-app-is-where-a-person-sees-and-manages-every-folder.md) at "Connect your agents": it lives in the Epicenter app, which shows connected agents.
- **Unbuilt:** all of it: the repository's and Messages' single-file routes as conditional HTTP; the stores' clients over them; "Connect your agents" in apps and the library.

## Context

The store's verbs are HTTP's conditional requests under other names: a read
returns a version, a write over a version is a `PUT` that must match it, a
write over `'absent'` creates only, `'stale'` is a failed precondition, and
`patch` is a `PATCH`. The repository's wire and Messages' served store each
invented routes for them. A greenfield look at a daemon or event bus, an MCP
server inside each app, and an MCP server in Rust found none that deletes
machinery: MCP has the agent start the server it needs, a Tauri app has no
JavaScript outside its window, and the tools need the contract, queries, and
the field primitive, which are TypeScript.

## Decision

**A store reached over HTTP reads and writes one file as HTTP does.**

| Store verb | HTTP |
| --- | --- |
| `read` one file | `GET`, its version as the `ETag` |
| `write(bytes, over: version)` | `PUT` with `If-Match` |
| `write(bytes, over: 'absent')` | `PUT` with `If-None-Match: *` |
| `write(null, over)` | `DELETE` with `If-Match` |
| `'stale'` | `412 Precondition Failed` |
| `patch` | `PATCH` with a JSON body `{ set, delete }` |

Reading many files at once, listing, and the changes since a commit stay
Epicenter's routes, since HTTP has none. `patch` is a top-level JSON Merge
Patch (RFC 7396) whose deletions are named, so a field can hold `null`; it is
sent as plain JSON, not as `application/merge-patch+json`.

**Agents reach Epicenter through the CLI, connected by an app.** `epicenter mcp`
runs in the CLI, started by the agent when it needs it. An app and the library
offer "Connect your agents": when a person clicks it, it installs the command
if it is missing and adds `epicenter mcp --all` to the agent's MCP
configuration. Nothing runs in the background to serve agents.

## Consequences

- A person can inspect or script a store with any HTTP client.
- The server's and Messages' single-file routes are replaced, not added to.
- Apps are for people and the CLI is for agents and terminals; an app's one
  part in agents' tools is the button that connects them.

## Considered alternatives

- **A daemon or event bus per computer:** a process that must always run and
  that every program must survive being down, deleting nothing: writers still
  guard against agents that write files directly, programs watch files
  themselves, and MCP starts its own server.
- **MCP inside each app:** a hidden window or a localhost server, working only
  while the app is open.
- **JSON Patch (RFC 6902):** operations on nested pointers and a `test` that
  duplicates the version, where a field is a value replaced whole.
- **JSON Merge Patch as is:** `null` deletes, so no contract could store `null`.
