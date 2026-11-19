# 0004. Trust the relay; reject zero-knowledge

- **Status:** Accepted
- **Date:** 2026-06-15
- **Reaffirmed by:** ADR-0277, which returns to this decision after ADR-0217 and ADR-0218 drifted from it without citing it.

## Context

Epicenter's server syncs every workspace through a relay (a Cloudflare Durable
Object per room). The open question was whether that relay should be able to read
workspace contents. A zero-knowledge design was drafted: encrypt every Yjs update
client-side under a keyring the server never holds, so the relay stores ciphertext
it cannot decrypt. That design carried real weight: a per-user and per-workspace
key hierarchy, an encrypted key-value wrapper, a keyring threaded through auth and
session, undecryptable-row handling, and the loss of server-side compaction.

The forcing question was whether server-blindness is a moat or a nice-to-have. It
is a nice-to-have. The product promise is login-only convenience, and the features
that matter (collaboration, server-side materialization, search, recovery) all want
the server to read plaintext. Zero-knowledge would tax every one of them to buy a
property few users asked for, and trusted to zero-knowledge is an additive future
move, while zero-knowledge to server-intelligence would be a regression.

## Decision

The relay is trusted and reads workspace plaintext. The zero-knowledge append-log
design is withdrawn. Privacy is a property of topology (who runs the anchor), not of
client-side cryptography. Secrets that genuinely must stay server-blind go in a
**vault**: an explicitly encrypted, shared workspace, not the default path.

## Consequences

- The entire workspace encryption layer is removed: `@epicenter/encryption`, the
  keyring, and the encrypted key-value wrapper. The storage-layer fallout (the read
  surface dropping from four buckets to three) is recorded in
  [ADR-0003](0003-three-read-states-after-encryption-removal.md).
- The keyring no longer threads through auth, session, or workspace construction.
- Server-side compaction, materialization, and search stay available because the
  server can read updates.
- Zero-knowledge remains reachable later as an additive opt-in without undoing this
  decision. The reverse would not have been true.

## Considered alternatives

- **Zero-knowledge append-log relay.** Rejected: it taxes collaboration,
  materialization, and recovery to buy server-blindness, which is not the moat.
- **Per-workspace encryption at rest, server holds keys.** Rejected: complexity of
  an encryption layer with none of the server-blindness benefit.
