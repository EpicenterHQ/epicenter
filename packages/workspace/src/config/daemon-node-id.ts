/**
 * Resolve a daemon's durable node identity for one Epicenter root.
 *
 * The daemon's identity is a durable nanoid persisted under `runtimeDir()`: the
 * same id file always yields the same NodeId, so a restart reuses the identity,
 * two folders on one machine get distinct ids (distinct files, keyed by dir
 * hash), and two machines never collide (the id is minted randomly on first
 * boot). The file lives under `runtimeDir()` (machine-local, OUTSIDE the repo
 * tree), not under `.epicenter/`, so it survives `git clean` and is never
 * accidentally committed.
 *
 * The NodeId is the relay's routing label (stamped on the room WebSocket as
 * `?nodeId=`) and the seed for the Y.Doc CRDT `clientID` via
 * `hashYDocClientId(nodeId)`. It is a plain claimed id, not a signing key: the
 * relay floor authenticates by the session's `principalId`, never the nodeId.
 *
 * Browser app nodeIds are the same kind of nanoid, persisted in Web Storage
 * via `createNodeId` / `createNodeIdAsync` in `document/node-id.ts`. This module
 * only differs in where the daemon persists its own: under the runtime dir
 * instead of storage.
 */

import { existsSync, readFileSync, writeFileSync } from 'node:fs';

import { nodeIdPathFor } from '../daemon/paths.js';
import { asNodeId, type NodeId } from '../document/node-id.js';
import { generateId } from '../shared/id.js';

/**
 * Read or lazily mint the daemon's durable node id for an Epicenter root,
 * persisting it at `nodeIdPathFor(epicenterRoot)`. Idempotent across restarts.
 *
 * A present-but-empty id file fails loud rather than rotating the identity:
 * silently minting a fresh id would re-seed `hashYDocClientId` and fork the
 * daemon's CRDT identity, so corruption is surfaced, not healed.
 */
export function resolveDaemonNodeId(epicenterRoot: string): NodeId {
	const path = nodeIdPathFor(epicenterRoot);
	if (existsSync(path)) {
		const stored = readFileSync(path, 'utf8').trim();
		if (stored.length === 0) {
			throw new Error(
				`resolveDaemonNodeId: node id file is empty at ${path}; refusing to ` +
					`rotate the daemon's identity (would fork its CRDT clientID)`,
			);
		}
		return asNodeId(stored);
	}
	const fresh = generateId<NodeId>();
	writeFileSync(path, fresh);
	return fresh;
}
