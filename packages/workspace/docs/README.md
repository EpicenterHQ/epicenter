# Epicenter Documentation

Technical documentation for the Epicenter package.

## Documentation Structure

```
docs/
├── architecture/       # System architecture
│   ├── network-topology.md    # Node types, connections
│   └── security.md            # Security model
│
├── blobs/              # Blob sync system
│   └── README.md              # Comprehensive guide
│
└── articles/           # Technical deep-dives
    ├── making-crdts-ergonomic-with-proxies.md
    ├── ytext-diff-sync.md
    └── ...
```

## Quick Links

### Architecture

- **[Network Topology](./architecture/network-topology.md)**: How devices connect (clients, servers, mesh)
- **[Security](./architecture/security.md)**: Tailscale, content-addressing, threat model

### Blob System

- **[Blob System Overview](./blobs/README.md)**: Comprehensive guide to content-addressed storage and sync

### Technical Articles

Deep-dives into implementation details:

- [Making CRDTs Ergonomic with Proxies](./articles/making-crdts-ergonomic-with-proxies.md)
- [Y.Text Diff Sync](./articles/ytext-diff-sync.md)
- [Y.Array Diff Sync](./articles/yarray-diff-sync.md)
- [TypeScript Serialization Patterns](./articles/typescript-serialization-patterns.md)

## Related Files

- [SYNC_ARCHITECTURE.md](../SYNC_ARCHITECTURE.md): Multi-node Yjs sync architecture
- [README.md](../README.md): Package overview and API reference
- [AGENTS.md](../AGENTS.md): Development guidelines
