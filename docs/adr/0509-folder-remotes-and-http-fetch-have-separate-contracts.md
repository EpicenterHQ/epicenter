# 0509. Folder remotes and HTTP fetch have separate contracts

- **Status:** Proposed
- **Date:** 2026-10-07

## Context

Browser folders synchronize ordinary Git repositories over Git's smart HTTP.
A remote names a canonical repository URL and a branch. An injected HTTP
function can route requests through a relay while retaining that canonical URL
in Git configuration. Native folders reach the same remote through the Git CLI
and its credential helpers.

The previous option name, `gitFetch`, could mean Git's fetch operation even
though the function also carries push requests. Calling it `authenticatedFetch`
would imply authentication is mandatory for public repositories and local
servers.

## Decision

Keep `remote: { url, branch }` and `httpFetch` as sibling browser options.
Name the fetch-compatible callable type `HttpFetch`. Use it for both Git fetch
and push; default to `globalThis.fetch`.

The remote is saved destination configuration. The HTTP function is a runtime
capability and is not serialized into the folder or Git configuration. Keep
provider credentials, relay routing, and session management in the transport
implementation. A connector may construct the remote and HTTP function together
without introducing a public `AuthenticatedRemote` wrapper.

A relay transport captures its permitted repository and authorization lifetime.
It must not silently borrow a replacement account's credentials. The relay
validates access and selects the credential destination. An option name does
not enforce those guarantees.

## Consequences

Rename `gitFetch` and `GitFetch` to `httpFetch` and `HttpFetch` in the folder
contract and current callers. Keep the callable signature, abort propagation,
canonical remote URLs, and native credential-helper path unchanged.

Repository URL, branch, and HTTP transport configure transfers, not the whole
folder. Storage, commit author, commit policy, and sync scheduling retain their
existing owners. GitHub authorization and a hosted connector remain separate
implementation work.

## Considered alternatives

- Nest the HTTP function inside `remote`: combines persisted destination
  settings with a browser runtime capability that native Git does not use.
- Flatten URL and branch into folder options: loses their remote context.
- Keep `gitFetch`: emphasizes Git scope but also names a specific Git operation.
- Use `authenticatedFetch`: makes authentication sound required by the contract.
- Introduce `GitTransport` or `AuthenticatedRemote`: duplicates the existing
  fetch-compatible seam without enforcing repository or session binding.

## References

- [Git smart HTTP](https://git-scm.com/docs/gitprotocol-http).
- [Git credential helpers](https://git-scm.com/docs/gitcredentials).
- [Folder contract](../../packages/folder/src/contract.ts) and
  [HTTP adapter](../../packages/folder/src/git/http.ts).
