# 0142. Workspace apps receive one connection while storage planes keep their own protocols

- **Status:** Accepted
- **Date:** 2026-07-14
- **Amends:** [ADR-0094](0094-the-connection-is-the-boot-decision-one-connect-call.md), [ADR-0141](0141-workspace-authority-is-selected-once-and-owns-one-local-database.md)

## Context

A synchronized browser workspace currently makes the application unpack one
boot decision into an authority, an authenticated fetch function, and a document
sync configuration. That exposes storage wiring which always moves together at
the application boundary. It does not follow that records and Yjs documents
should share a wire protocol: their replication, recovery, and ordering rules
remain different.

## Decision

An application passes one `WorkspaceConnection` to its workspace opener:

```ts
type WorkspaceConnection =
	| { kind: 'local' }
	| {
			kind: 'server';
			baseURL: string;
			principalId: PrincipalId;
			fetch: AuthenticatedFetch;
			openWebSocket: OpenAuthenticatedWebSocket;
			onReconnectSignal: OnReconnectSignal;
	  };
```

The auth package projects its boot snapshot into this value. Applications call
the runtime once:

```ts
openBrowserWorkspace(definition, {
	worker: () => new WorkspaceWorker(),
	connection: toWorkspaceConnection(auth),
});
```

The connection is immutable for that workspace lifetime. A principal change
closes the current runtime and reopens the application against a new boot
snapshot, as decided by ADR-0141. A local workspace and a principal-owned
workspace are distinct stores. Sign-in never silently adopts local rows or
documents; any product that offers adoption owns an explicit, reviewed import.

The workspace runtime derives authority-qualified database names and owns both
network planes. Records synchronize through the semantic HTTP replication
protocol for open, push, pull, and snapshots. Each active Yjs document
synchronizes through its authenticated room WebSocket. Reconnect signals wake
both planes, but neither protocol is wrapped in the other and the server does
not gain a universal synchronization socket.

`baseURL` and `principalId` qualify the local storage namespace. On the wire,
the principal is carried only by the authenticated transport: it never appears
in a room URL, query parameter, or Yjs frame. `onReconnectSignal` remains a
capability because an auth transition from `reauth-required` back to
`signed-in` must wake a parked document supervisor without changing authority.

## Consequences

Applications no longer understand record sync ports, fetch ownership, document
sync options, room URLs, or storage names. `@epicenter/workspace` remains
auth-agnostic because it accepts transport capabilities rather than an auth
client.

Records and documents become similar where that is true: both are local
materializations, queue local changes, catch up after reconnect, and expose one
workspace lifetime. They remain different where correctness demands it. Record
sync keeps its ordered mutation log, cursor, and snapshots. Yjs keeps state
vectors and CRDT updates. A physical WebSocket per active document remains the
simple default; multiplexing every document onto one socket would add a routing
protocol without changing the application API.
