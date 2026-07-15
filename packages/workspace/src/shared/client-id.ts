/**
 * Stable Yjs `clientID` derivation for ephemeral peers.
 *
 * Yjs assigns a random 53-bit `clientID` to each `Y.Doc` and retains every
 * mutation it produces in the StructStore for the life of the document.
 * Naive ephemeral peers (vault scripts launched per invocation) would mint
 * a fresh random clientID per process, leaving one StructStore entry per
 * invocation in the durable document's state vector.
 *
 * `hashYDocClientId(path)` derives a stable 53-bit positive integer from a
 * string identity (typically `Bun.main`). Two invocations of the same
 * script reuse the same Y.Doc CRDT clientID; their writes merge under Yjs
 * causality. The state vector grows with the count of distinct scripts
 * that mutate, not the count of invocations.
 *
 * Distinct from the wire-level `nodeId: string` the relay routes by:
 * this is the Y.Doc CRDT identifier (a number Yjs stamps into every
 * update), not the WebSocket connection identity.
 *
 * Output range: `[1, 2^53 - 1]`. Zero is reserved by Yjs for "no peer";
 * we shift by one to keep the contract clean. Collisions are
 * astronomically unlikely on a single-machine peer population.
 */

import { createHash } from 'node:crypto';

/** 53-bit mask, the safe-integer ceiling Yjs uses for clientID. */
const FIFTY_THREE_BIT_MASK = 0x1fffffffffffffn;

/**
 * Derive a stable 53-bit positive integer Y.Doc CRDT `clientID` from a
 * string path.
 *
 * @param path A stable identity string. Typically `Bun.main`.
 * @returns A positive integer in `[1, Number.MAX_SAFE_INTEGER]`.
 */
export function hashYDocClientId(path: string): number {
	const digest = createHash('sha256').update(path).digest();
	// Read the first 8 bytes as a big-endian unsigned 64-bit integer, mask
	// to 53 bits, and add 1 so the result is always > 0 (Yjs reserves
	// clientID 0 for "no peer").
	const high = BigInt(digest.readUInt32BE(0));
	const low = BigInt(digest.readUInt32BE(4));
	const combined = (high << 32n) | low;
	const masked = combined & FIFTY_THREE_BIT_MASK;
	return Number(masked) + 1;
}
