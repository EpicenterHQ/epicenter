# Security Model

This document describes the security layers in an Epicenter network and threat mitigation strategies.

## Security Layers

### Layer 1: Network (Tailscale)

Tailscale provides the primary network security layer:

| Feature               | Protection                               |
| --------------------- | ---------------------------------------- |
| WireGuard encryption  | All traffic encrypted in transit         |
| Node authentication | Only your devices can join your tailnet  |
| Private mesh          | Devices not exposed to public internet   |
| ACLs                  | Can restrict which devices talk to which |

**If you're only on Tailscale, you get network-level security "for free".**

### Layer 2: Application (Epicenter)

#### Current (Minimal, Trusts Network)

```
┌────────────────────────────────────────────────────────────────────────┐
│  • No authentication on WebSocket connections                          │
│  • Anyone who can reach the server can sync                           │
│  • Relies on Tailscale for access control                             │
│                                                                        │
│  APPROPRIATE FOR: Personal devices on private Tailscale network       │
└────────────────────────────────────────────────────────────────────────┘
```

#### Optional Hardening

##### Pre-Shared Key

Configure a secret key across all your devices:

```typescript
// Server
const server = createEpicenterServer({
	auth: {
		psk: process.env.EPICENTER_PSK,
	},
});

// Client
const provider = createSyncExtension({
	url: 'ws://server:3913/rooms/{id}',
	token: process.env.EPICENTER_PSK,
});
```

Server rejects connections without a valid key.

##### End-to-End Encryption

Encrypt blobs before storing:

```typescript
// Encrypt with a key only your devices have
const encrypted = await encrypt(blobData, SHARED_KEY);
await blobStore.put(encrypted);

// Server stores encrypted chunks
// Cannot read content without SHARED_KEY
```

### Layer 3: Blob Integrity

Content-addressing provides tamper detection:

```
┌────────────────────────────────────────────────────────────────────────┐
│  Hash = SHA-256 of content                                             │
│                                                                        │
│  Request: "Give me sha256:abc123"                                      │
│  Response: [data]                                                      │
│  Verify: SHA-256(data) === "abc123"                                    │
│                                                                        │
│  If tampered → hash mismatch → rejected                                │
│  A malicious server CANNOT serve fake data for a hash.                 │
└────────────────────────────────────────────────────────────────────────┘
```

## Threat Model

### Protected Against (with Tailscale + Content-Addressing)

| Threat             | Protection                            |
| ------------------ | ------------------------------------- |
| External attackers | Tailscale: can't reach your tailnet   |
| Data tampering     | Content-addressing: hash verification |
| Man-in-the-middle  | WireGuard: encrypted tunnel           |
| Eavesdropping      | WireGuard: encrypted tunnel           |
| Replay attacks     | Yjs vector clocks: deduplication      |

### NOT Protected Against (without additional measures)

| Threat                        | Mitigation                          |
| ----------------------------- | ----------------------------------- |
| Compromised node in tailnet | E2E encryption, node allowlist    |
| Physical node access        | Node encryption, strong passwords |
| Malicious software on node  | OS security, code signing           |
| Insider with network access   | Pre-shared key, node allowlist    |

## Recommendations by Use Case

### Personal Devices (3-5 devices, single user)

```
RECOMMENDED:
✅ Tailscale (private mesh)
✅ Content-addressing (integrity)

OPTIONAL:
○ Pre-shared key (extra layer)
○ Node allowlist (audit trail)

NOT NEEDED:
✗ Full authentication system
✗ E2E encryption (you trust your own devices)
```

### Small Team (5-10 devices, multiple users)

```
RECOMMENDED:
✅ Tailscale (private mesh)
✅ Content-addressing (integrity)
✅ Pre-shared key or auth tokens
✅ Node allowlist

CONSIDER:
○ E2E encryption (for sensitive data)
○ Audit logging
```

### Production / Multi-Tenant

```
REQUIRED:
✅ TLS (wss://)
✅ Authentication (JWT, OAuth)
✅ Authorization (per-workspace permissions)
✅ E2E encryption
✅ Audit logging
✅ Rate limiting
```

## WebSocket Security

### Without TLS (ws://)

```
┌────────────────────────────────────────────────────────────────────────┐
│  OK for:                                                               │
│  • Tailscale (already encrypted via WireGuard)                        │
│  • localhost connections                                               │
│                                                                        │
│  NOT OK for:                                                           │
│  • Public internet                                                     │
│  • Untrusted networks                                                  │
└────────────────────────────────────────────────────────────────────────┘
```

### With TLS (wss://)

Required for public internet exposure:

```typescript
const server = createEpicenterServer({
	port: 443,
	tls: {
		cert: fs.readFileSync('cert.pem'),
		key: fs.readFileSync('key.pem'),
	},
});
```

## Blob-Specific Security

### Content-Addressed Integrity

Every blob chunk is verified:

```typescript
async function verifyChunk(chunk: BlobChunk): Promise<boolean> {
	const computed = await sha256(chunk.data);
	return chunk.hash === `sha256:${computed}`;
}

// On receipt, verify before storing
if (!(await verifyChunk(chunk))) {
	throw new Error('Chunk failed integrity check');
}
```

### Blob Access Control

The blob registry is public within the network. Anyone who can sync the Y.Doc can see:

- What blobs exist
- Which servers have them
- Blob metadata (size, type)

**For sensitive blobs**: Use E2E encryption so registry visibility doesn't leak content.

## Related Documentation

- [Network Topology](./network-topology.md): Connection architecture
- [Blob Sync Protocol](../blobs/sync-protocol.md): Blob transfer security
