# 0141. Workspace authority is selected once and owns one local database

- **Status:** Accepted
- **Date:** 2026-07-14
- **Amends:** [ADR-0088](0088-sign-in-is-an-enhancement-never-a-door.md), [ADR-0092](0092-identity-is-the-partition.md), [ADR-0094](0094-the-connection-is-the-boot-decision-one-connect-call.md), [ADR-0135](0135-new-builds-ask-before-initializing-a-new-data-generation.md), [ADR-0137](0137-applications-declare-one-live-workspace-per-contract-version.md), [ADR-0140](0140-portable-ownership-has-no-generic-whole-workspace-import.md)

## Context

One application version may run without an account or as a synchronized replica
for one principal at one deployment. Reusing one browser database across those
modes would make sign-in an authority transfer and require merge, replacement,
or continuous-copy semantics. Treating storage mode, deployment, and principal
as unrelated options would instead let callers compose identities that disagree.

## Decision

A workspace opens against exactly one `WorkspaceAuthority`, selected once at
boot:

```ts
type WorkspaceAuthority =
	| { kind: 'local' }
	| { kind: 'server'; baseURL: string; principalId: PrincipalId };
```

`local` produces a standalone database. `server` produces a complete local
replica of the workspace owned by that normalized deployment and principal.
The application-authored workspace ID remains `<appId>-v<version>`; authority
qualifies the local materialization and server partition without becoming
another application version or a user-authored workspace ID.

Browser storage names are deterministic:

```text
<workspaceId>.standalone.sqlite3
<workspaceId>.replica-<authorityHash>.sqlite3
```

`authorityHash` is lowercase hexadecimal SHA-256 over a versioned domain
separator, the normalized server base URL, and the principal ID, separated by
NUL bytes. It is an internal non-secret partition key. The same derived database
name scopes OPFS access and same-origin invalidation channels.

The page owns authenticated HTTP. The application Worker owns SQLite and the
replica supervisor. They communicate through a semantic `ReplicaSyncPort`
MessagePort protocol that carries record-sync operations, never a generic fetch
proxy or credentials.

Changing authority requires closing the current runtime and booting another;
applications reload on principal changes rather than swapping authority in
place. Local and server authorities are independent live workspaces. Epicenter
does not automatically copy, merge, or delete between them.

An application may later initialize an absent target or import selected domain
objects using ordinary forward writes. A live target has no generic workspace
copy operation. Application-specific imports own selection, identity conflicts,
review, retry, and partial failure; no such importer is part of the initial
platform runtime.

## Consequences

- Signed-out and signed-in data cannot silently overwrite or resurrect one
  another.
- Two principals or deployments on one browser never share SQLite replica
  state, outboxes, cursors, or broadcast invalidations.
- The Worker receives no bearer, refresh token, cookie, or arbitrary HTTP
  capability.
- There is one browser opener and one app-owned Worker entry point for both
  authority kinds; the former standalone and replica browser openers are
  removed rather than aliased.
- Sign-in may reveal a different independent workspace. Preserving or importing
  local domain data is explicit application product work, not an auth side
  effect.
- A failed or partial future initialization cannot be treated as live until the
  target's complete identity is finalized. This decision does not add that copy
  implementation.

## Considered alternatives

- **Reuse one local database and add sync after sign-in.** Rejected because the
  same pages, outbox, and history would change authority in place.
- **Make `standalone` and `replica` caller-authored modes.** Rejected because
  they are derived roles of authority, not independent identity choices.
- **Put authenticated fetch inside the Worker.** Rejected because auth owns
  credential refresh and state transitions on the page.
- **Bridge generic fetch through MessagePort.** Rejected because it grants the
  Worker a second arbitrary network surface when it needs only five record-sync
  operations.
- **Automatically copy the local workspace on sign-in.** Rejected because a
  server target may already contain unrelated state and each application has
  different domain ownership and conflict semantics.
