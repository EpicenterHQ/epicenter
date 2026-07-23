# @epicenter/sync

`@epicenter/sync` owns two protocol boundaries shared by Epicenter clients and
servers:

- `@epicenter/sync/document-v3`: the Yjs 14 wire format for one
  record-addressed document
- `@epicenter/sync/auth-subprotocol`: WebSocket authentication subprotocol
  constants and parsing

The package has no root export. Import the boundary you need directly.

## Document V3

Each Document V3 WebSocket is already scoped by its authenticated route:

```txt
/api/sync/v1/records/:namespace/:collection/:recordKey/document
```

The socket therefore carries document-local messages, not an arbitrary room
identifier:

```txt
sync-request(stateVector)
sync-response(missingUpdate)
update(incrementalUpdate)
publication-response(acceptanceBytes)
```

The selected `epicenter-document-v3` WebSocket subprotocol owns the protocol
major. WebSocket preserves message boundaries, so each binary message contains
one frame-kind byte followed by its payload.

```typescript
import * as Y from '@y/y';
import {
	decodeDocumentFrame,
	encodeDocumentFrame,
} from '@epicenter/sync/document-v3';

const doc = new Y.Doc();
const request = encodeDocumentFrame({
	kind: 'sync-request',
	stateVector: Y.encodeStateVector(doc),
});

const frame = decodeDocumentFrame(request);
if (frame.kind === 'sync-request') {
	const response = encodeDocumentFrame({
		kind: 'sync-response',
		update: Y.encodeStateAsUpdateV2(doc, frame.stateVector),
	});
	// Send `response` over the document's WebSocket.
}
```

The protocol exports the document resource bound and helpers that measure a
live or encoded Yjs 14 document against it. The authority remains responsible
for enforcing that bound and accepting publications.

Document V3 does not own scalar record convergence, local persistence,
arbitrary rooms, presence, multiplexing, or generic provider lifecycle.

## WebSocket authentication

Bearer credentials travel in `Sec-WebSocket-Protocol`, not in the request URL.
Clients offer the main protocol plus a `bearer.<token>` entry. Servers parse
the list, consume the bearer entry during authentication, and echo only the
selected application protocol.

```typescript
import {
	BEARER_SUBPROTOCOL_PREFIX,
	MAIN_SUBPROTOCOL,
	parseSubprotocols,
} from '@epicenter/sync/auth-subprotocol';

const offered = parseSubprotocols(request.headers.get('Sec-WebSocket-Protocol'));
const bearer = offered.find((value) =>
	value.startsWith(BEARER_SUBPROTOCOL_PREFIX),
);

if (!offered.includes(MAIN_SUBPROTOCOL) || !bearer) {
	throw new TypeError('Missing Epicenter WebSocket credentials');
}
```

`OpenWebSocketDenial` and `isOpenWebSocketDenial` describe client-side
credential refusal before a socket opens.

## Package relationships

```text
record authority              liveness, bounds, publications, fanout
        │
@epicenter/data               record-addressed document API
        │
@epicenter/document-sync      publication and realtime coordination
        │
@epicenter/sync/document-v3   single-document wire
        │
@y/y 14                       CRDT state and update encoding
```

`@epicenter/sync/auth-subprotocol` is also shared by authentication and relay
routes that do not participate in document synchronization.

## License

MIT. The package is protocol vocabulary in the embeddable developer toolkit.
