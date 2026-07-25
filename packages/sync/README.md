# @epicenter/sync

`@epicenter/sync` holds the Yjs 14 facts both endpoints of a row document must
agree on. Row documents converge over HTTP (ADR-0171), so what this package
still owns for them is the shared admission bound, not a wire protocol.

> Transition status: the package still contains Yjs 13 per-room framing. That
> code is precedent for encoding and awareness behavior only. ADRs 0145 and
> 0146 do not preserve its peer dependency, arbitrary room ids, route shape,
> persisted format, or wire compatibility.

## Proposed destination

The final protocol is scoped to one authenticated row document:

```txt
/api/sync/v1/records/:namespace/:collection/:recordKey/document
  sync-request(stateVector)
  sync-response(missingUpdate)
  update(incrementalUpdate)
  publication-response(acceptanceBytes)
```

Row documents have no WebSocket (ADR-0171). `document-v3` is therefore not a
wire protocol at all: it is the one shared measurement both endpoints use to
decide whether a document may be admitted. The replica premeasures it to keep
an over-bound payload off the wire, and the authority enforces it exactly on
the state produced by joining a submission, so the authority's answer is final.

`DOCUMENT_PAYLOAD_BYTES` derives from that bound rather than sitting beside it,
so a route and a carrier cannot disagree about what body size is admissible.

The package targets only `@y/y` 14. It will expose the document wire vocabulary,
Yjs 14 sync encoding and the provider behavior needed by
`RowDocument`. It will not expose scalar row sync, SQLite storage, multiplexed
subscription recovery, per-room authority ownership, or a generic user-selected
room service.

Browser and native clients share provider semantics without sharing storage:

```txt
RowDocument
  local persistence          replica SQLite document chains
  network                    one WebSocket while this document is open
  durability                 invocation-time local update cut
  connection                 reactive per-document status
```

Local persistence replays Yjs 14 updates, appends every observed update,
compacts at bounded thresholds, and fails closed on corruption or eviction.
The wire can return post-commit acceptance proof. Production runtime settlement
remains deliberately absent until the caller migration wave; local persistence
stays the durable offline owner.

## Current Yjs 13 implementation

### Installation

Inside this monorepo:

```json
{
  "dependencies": {
    "@epicenter/sync": "workspace:*"
  }
}
```

The current package has a peer dependency on `yjs`. The destination removes it
in favor of the repository's pinned `@y/y` 14 line.

### Quick usage

The core flow is small on purpose: encode a sync message, send it over whatever transport you want, then decode or handle it on the other side.

```typescript
import * as Y from "yjs";
import {
  MESSAGE_TYPE,
  SYNC_MESSAGE_TYPE,
  decodeMessageType,
  decodeSyncMessage,
  encodeSyncStep1,
  handleSyncPayload,
} from "@epicenter/sync";

const doc = new Y.Doc();
doc.getMap("users").set("alice", { name: "Alice", age: 30 });

const step1 = encodeSyncStep1({ doc });
const messageType = decodeMessageType(step1);

if (messageType === MESSAGE_TYPE.SYNC) {
  const decoded = decodeSyncMessage(step1);

  if (decoded.type === "step1") {
    const response = handleSyncPayload({
      syncType: SYNC_MESSAGE_TYPE.STEP1,
      payload: decoded.stateVector,
      doc,
      origin: null,
    });

    // send response over WebSocket, HTTP, BroadcastChannel, or anything else
  }
}
```

That example is the same shape used in the package tests and in the API room bootstrap, where the server starts a connection with `encodeSyncStep1({ doc })`.

### Current framing boundary

This package is strict about one boundary: it handles protocol framing, not connection management. That split is why the same message helpers work over WebSockets, BroadcastChannel, or any custom relay you want to write.

The design shows up in a few places:

- `encodeSyncStep1`, `encodeSyncStep2`, and `encodeSyncUpdate` only deal with Yjs payloads.
- RPC framing is separate from RPC behavior. The package defines request/response bytes and shared error variants, not the transport policy around retries or timeouts.

If you want lifecycle helpers for a WebSocket server, this package is the protocol layer under them. Not the server itself.

### Current API overview

Main exports from `src/index.ts`:

- Message constants: `MESSAGE_TYPE`, `SYNC_MESSAGE_TYPE`, `RPC_TYPE`
- Sync encode/decode: `encodeSyncStep1`, `encodeSyncStep2`, `encodeSyncUpdate`, `decodeSyncMessage`, `handleSyncPayload`
- Awareness helpers: `encodeAwareness`, `encodeAwarenessStates`, `encodeQueryAwareness`
- RPC helpers: `encodeRpcRequest`, `encodeRpcResponse`, `decodeRpcMessage`, `decodeRpcPayload`
- RPC types and guards: `DecodedRpcMessage`, `RpcError`, `isRpcError`

The package exports pure functions. Feed them bytes and docs; they give you bytes or decoded shapes back.

## Destination relationship to other packages

`@epicenter/sync` sits below the rest of the sync stack.

```text
@epicenter/server       authority acceptance and HTTP document routes
        │
@epicenter/data         runtime-owned RowDocument handles, publication, and pull
        │
@epicenter/sync         the shared document bound and its measurement
        │
@y/y 14                 CRDT state, awareness, and update encoding
```

In practice:

- The server authority measures the post-join state against it inside the one
  acceptance function.
- `@epicenter/data` measures the same bound locally, behind the runtime-owned
  `RowDocument` handle and its HTTP publication.
- Scalar convergence never imports it; it is a separate protocol plane.

## License

MIT. `@epicenter/sync` is wire-protocol vocabulary in the developer toolkit (code you build with), so it is MIT like the rest of the toolkit. That matches the package manifest.
