# Network Topology

> **Status note:** This document describes the sync topology. The current architecture uses a **remote server** (`apps/api`) that handles auth (Better Auth), AI streaming, AI proxy, and a Yjs relay. A local sidecar tier was previously planned but has been removed. The local-mesh topology described below is aspirational and not yet implemented.

Epicenter uses a **leaderless, bidirectional graph** topology for syncing data across devices. This document describes the node types, connection rules, and example configurations.

## Node Types

There are two types of nodes in an Epicenter network:

### Clients (Browsers)

| Property                 | Value                             |
| ------------------------ | --------------------------------- |
| Runtime                  | Browser (Chrome, Safari, Firefox) |
| Storage                  | OPFS (Origin Private File System) |
| Can accept connections   | No                                |
| Can initiate connections | Yes (to servers only)             |
| Can serve blobs          | No                                |
| Listed in blob registry  | No                                |

Clients are browser-based applications that connect TO servers but cannot accept incoming connections.

### Servers (Bun/Node)

| Property                 | Value                  |
| ------------------------ | ---------------------- |
| Runtime                  | Bun or Node.js         |
| Storage                  | Filesystem             |
| Can accept connections   | Yes (WebSocket)        |
| Can initiate connections | Yes (to other servers) |
| Can serve blobs          | Yes                    |
| Listed in blob registry  | Yes                    |

Servers run on devices like laptops and desktops. They can both accept connections from clients and initiate connections to other servers.

## Connection Rules

```
Client ──► Server     ✅  (WebSocket)
Client ──► Client     ❌  (browsers can't accept connections)
Server ──► Server     ✅  (WebSocket, for server-to-server sync)
Server ──► Client     ❌  (clients can't accept connections)
```

This creates a **hub-and-spoke with mesh** topology:

- Clients connect to one or more servers (spokes)
- Servers connect to each other (mesh)

## Example Topology

A typical personal setup with 3-5 devices:

```
                        TAILSCALE MESH

         ┌──────────────────────────────────────────────────────┐
         │                                                      │
         │    ┌─────────┐           ┌─────────┐                │
         │    │LAPTOP A │           │LAPTOP B │                │
         │    │         │           │         │                │
         │    │ Browser │           │ Browser │                │
         │    │    │    │           │    │    │                │
         │    │    ▼    │           │    ▼    │                │
         │    │ Server ◄├───────────┼► Server │     ┌────────┐ │
         │    │ :3913   │  server   │  :3913  │     │ PHONE  │ │
         │    └────▲────┘  to       └────▲────┘     │        │ │
         │         │       server        │          │Browser │ │
         │         │                     │          └───┬────┘ │
         │         │                     │              │      │
         │         └─────────────────────┴──────────────┘      │
         │                        ▲                            │
         │                        │                            │
         │              Phone connects to BOTH                 │
         │              servers for redundancy                 │
         │                                                     │
         └─────────────────────────────────────────────────────┘
```

### Adjacency List

```
laptop-a-browser  ──► [laptop-a-server]
laptop-b-browser  ──► [laptop-b-server]
phone-browser     ──► [laptop-a-server, laptop-b-server]
laptop-a-server   ◄──► [laptop-b-server]
laptop-b-server   ◄──► [laptop-a-server]
```

### Node Count

| Location         | Y.Doc Count | Notes                         |
| ---------------- | ----------- | ----------------------------- |
| Phone browser    | 1           | Client only (no local server) |
| Laptop A browser | 1           | Connects to localhost         |
| Laptop B browser | 1           | Connects to localhost         |
| Laptop A server  | 1           | Sync node                     |
| Laptop B server  | 1           | Sync node                     |
| **Total**        | **5**       | All stay in sync via Yjs      |

## Provider Configuration

### Phone Browser (Client Only)

Phone has no local server, so it connects directly to all available servers:

```typescript
providers: {
  syncToLaptopA: createSyncExtension({
    url: 'ws://laptop-a.tailnet:3913/rooms/{id}'
  }),
  syncToLaptopB: createSyncExtension({
    url: 'ws://laptop-b.tailnet:3913/rooms/{id}'
  }),
}
```

### Laptop Browser (Client)

Browser connects to its own local server:

```typescript
providers: {
  sync: createSyncExtension({
    url: 'ws://localhost:3913/rooms/{id}'
  }),
}
```

### Laptop Server (Server + Client)

Server accepts connections AND connects to other servers:

```typescript
// Laptop A server connects to Laptop B
providers: {
  syncToLaptopB: createSyncExtension({
    url: 'ws://laptop-b.tailnet:3913/rooms/{id}'
  }),
}

// Note: Laptop A also ACCEPTS connections via createSyncPlugin
```

## Why Multiple Providers Work

Yjs supports **multiple providers simultaneously**:

```typescript
const doc = new Y.Doc();

// Connect to multiple servers via createSyncProvider from @epicenter/sync
const provider1 = createSyncProvider({
	doc,
	url: 'ws://laptop-a.tailnet:3913/rooms/blog',
});
const provider2 = createSyncProvider({
	doc,
	url: 'ws://laptop-b.tailnet:3913/rooms/blog',
});

// Changes sync through ALL connected providers
// Yjs deduplicates updates automatically (vector clocks)
```

### Properties

- **CRDTs**: Updates merge regardless of order
- **Vector Clocks**: Same update received twice is applied once
- **Eventual Consistency**: All Y.Docs converge to identical state
- **Resilience**: If one server is down, others continue syncing

## Offline Support

Each node should use local persistence alongside network sync:

```typescript
providers: {
  // Local persistence (IndexedDB in browser, filesystem in Node.js)
  persistence: setupPersistence,

  // Network sync (via @epicenter/sync)
  sync: createSyncExtension({ url: 'ws://localhost:3913/rooms/{id}' }),
}
```

When offline:

1. Changes saved to local storage
2. When back online, Yjs syncs missed updates
3. CRDTs ensure consistent merge

## Related Documentation

- [Security](./security.md): Network security model
- [Blob Sync](../blobs/README.md): How binary files sync across the network
