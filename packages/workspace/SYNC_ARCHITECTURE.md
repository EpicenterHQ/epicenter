# Workspace synchronization architecture

Applications receive one boot-time `WorkspaceConnection`:

```ts
type WorkspaceConnection =
	| { kind: 'local' }
	| {
			kind: 'server';
			baseURL: string;
			principalId: PrincipalId;
			fetch: WorkspaceFetch;
			openWebSocket: OpenWebSocketFn;
			onReconnectSignal: OnReconnectSignal;
	  };
```

`toWorkspaceConnection(auth)` creates this value from one auth snapshot. Apps
pass it once and do not construct storage names, room URLs, record sync ports,
or document sync options.

## Two data planes

The one connection feeds two synchronization engines:

```text
openBrowserWorkspace
|-- SQLite records
|   `-- authenticated HTTP: open, push, pull, snapshots
|-- synchronized KV Y.Doc
|   `-- authenticated WebSocket room
`-- lazy child Y.Docs
    `-- authenticated WebSocket room per open document
```

The planes share authentication and lifetime, not a wire protocol. SQLite
records use ordered semantic mutations and snapshot recovery. Yjs documents
use state vectors and CRDT updates. Combining them into one universal socket
would add routing and recovery coupling without simplifying the app API.

## Room identity

A server connection selects the authenticated principal partition. A document
guid selects one room inside that partition:

```text
wss://<deployment>/api/rooms/<document-guid>
```

There is no installation identifier in the URL, socket attachment, or room
state. The relay tracks open sockets only to fan out Yjs updates and enforce a
bounded authenticated connection lifetime. It publishes no generic peer list
or device presence.

```ts
const url = roomWsUrl({
	baseURL: connection.baseURL,
	guid: ydoc.guid,
});
```

The auth-owned WebSocket opener attaches the bearer. The server resolves the
principal, derives the principal-owned room name, and upgrades the original
request. The selected room then exchanges binary y-protocols sync frames.

## Local persistence and reconnect

Every browser Y.Doc loads IndexedDB before collaboration begins. Local
connections also use BroadcastChannel for same-origin contexts. Server
connections qualify local storage by deployment and principal so signed-out
and signed-in data never collide.

Local edits remain usable while offline. The sync supervisor retries with
backoff, wakes on auth state changes, and performs a fresh Yjs handshake after
reconnect. A new context catches up from local IndexedDB and the persisted room
even when no prior context remains open.

## Deliberate refusals

- No stable machine or installation identity.
- No generic online-device or peer API.
- No same-installation tab deduplication.
- No deterministic Yjs client ID across process restarts.
- No universal records-plus-documents synchronization protocol.

A concrete product may add scoped ephemeral identifiers for a live session,
such as a Super Chat attach host. Collaborative cursors may later use
document-scoped Yjs awareness. Neither becomes framework installation identity.
