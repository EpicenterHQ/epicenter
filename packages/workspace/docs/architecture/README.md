# Architecture Documentation

System architecture documentation for Epicenter's distributed sync system.

## Documents

| Document                                  | Description                                                      |
| ----------------------------------------- | ---------------------------------------------------------------- |
| [Network Topology](./network-topology.md) | Node types (client/server), connection rules, example topologies |
| [Security](./security.md)                 | Security layers (Tailscale, content-addressing), threat model    |

## Quick Reference

> **Topology note:** Epicenter uses a two-tier architecture. Browsers connect to the remote server (`apps/api`) which handles auth (Better Auth), AI streaming (`/ai/chat`), and a Yjs relay. A local sidecar tier was previously planned but has been removed. See [Network Topology](./network-topology.md) for the full picture.

### Node Types

| Type          | Runtime  | Can Accept Connections | Can Serve Blobs | Notes                                           |
| ------------- | -------- | ---------------------- | --------------- | ----------------------------------------------- |
| Client (SPA)  | Browser  | No                     | No              | Data + AI → remote server                       |
| Remote Server | Bun/Node | Yes                    | No              | `apps/api`; auth, AI proxy, Yjs relay |

### Connection Rules

```
Client ──► Remote Server  ✅  (WebSocket, HTTP: data sync, AI, auth)
Server ──► Server         ✅  (WebSocket)
```

Note: Direct connections are only possible **to** servers. The old relay-floor
route exposure and generic presence paths were deleted. A future box-access
surface would be a product-scoped capability outside document sync.

### Typical Setup

```
         ┌─────────┐           ┌─────────┐          ┌────────┐
         │LAPTOP A │           │LAPTOP B │          │ PHONE  │
         │ Browser │           │ Browser │          │Browser │
         └────┬────┘           └────┬────┘          └───┬────┘
              │                     │                   │
              └─────────────────────┼───────────────────┘
                                    │
                              ┌─────▼─────┐
                              │  Remote   │
                              │  Server   │
                              └───────────┘
```

## Related Documentation

- [Blob System](../blobs/README.md): How binary files sync
- [SYNC_ARCHITECTURE.md](../../SYNC_ARCHITECTURE.md): Yjs sync details
