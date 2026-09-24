# 0090. The blob layer stays plaintext; confidentiality belongs to the encrypting consumer

- **Status:** Accepted
- **Date:** 2026-07-01

- **Amended by:** [ADR-0427](0427-opening-a-blob-acquires-presentation-without-retaining-a-copy.md) at media delivery: plaintext and a locator alone do not establish authenticated range playback. The mandatory presigned/redirect transport is not retained; encryption ownership is unchanged.

- **Amended by ADR-0426 (blob identity only):** [Scoped opaque identities](0426-copies-create-independent-blobs-at-their-destination.md) replace the historical content-hash addressing assumption below. Consumer-owned encryption remains unchanged.

## Context

Blobs will carry personal media (audio, images, PDFs), which raised the question of blob-layer encryption. The system's precedent points one way: the sync anchor deliberately reads workspace plaintext ([ADR-0004](0004-trust-the-relay-reject-zero-knowledge.md)), the secret vault runs on an operator-readable server-derived keyring ([ADR-0074](0074-the-secret-vault-is-an-owner-scoped-synced-store-encrypted-under-a-server-derived-keyring.md)), and privacy is a deployment choice ([ADR-0068](0068-privacy-is-a-deployment-not-a-product-feature.md)). Blob-layer E2EE would make raw media the most operator-blind data class in the system while the designated confidential store is not, and it would charge every consumer for streaming crypto, dead ranged reads, dead previews, and a key-recovery story that only some consumers need.

## Decision

The blob layer does not encrypt. A consumer that needs confidentiality encrypts before `blobs.add` and owns its key management, format, and plaintext-to-address mapping; the ciphertext hash becomes the content address and the store requires zero changes, because the address was always "the hash of the stored bytes", never "the hash of the plaintext".

## Consequences

Hosted blobs are operator-readable like every other hosted data class, so no hosted surface may claim "private" without either self-host framing or a shipped encrypting consumer. Plaintext blobs keep ranged reads, streaming playback, and browser preview for free; a consumer choosing whole-blob AEAD forfeits those for its own objects and that is its trade. Cross-owner hash equality is visible to bucket-level readers for every plaintext blob and is not retrofittable for already-stored bytes. Decision triggers that force the consumer-side choice: Whispering recordings must settle their posture before the first recording lands in a hosted bucket (voice is biometric, and playback wants ranges), and vault attachments must match the ADR-0074 keyring posture.

## Considered alternatives

- Per-owner random-nonce E2EE at the blob layer: inverts the trust model relative to ADR-0004/0074 and taxes all consumers for a property none currently exercises.
- Convergent encryption: preserves dedupe but leaks equality and enables confirmation attacks on guessable files; the highest crypto-design risk for the smallest prize, since dedupe is owner-local anyway.
