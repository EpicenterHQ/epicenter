/**
 * Node id helper plus the branded `NodeId` type.
 *
 * A node id is a stable string that identifies one Epicenter app on one
 * persistent storage scope. Browser tabs sharing localStorage share an id;
 * separate browsers, the extension, Tauri windows, and Node processes each
 * get distinct ids because their storage scopes are distinct. The id is
 * generated on first call and persisted in the supplied storage; subsequent
 * calls return the persisted value.
 *
 * "Node" is the identity concept behind a presence entry (`Peer`).
 * The id behind it is what the relay routes by and what every consumer reads.
 *
 * Node ids are claimed by the client and only the client knows them. They
 * are passed to `openCollaboration` as the `nodeId` config field, stamped
 * onto the WebSocket upgrade URL (the relay binds the id to the socket at
 * upgrade and stores it on the socket attachment for the lifetime of the
 * connection: no round-trip validation).
 *
 * The id deliberately survives a workspace `wipe()`: it is install identity
 * (this app on this storage scope), not account data, so deleting an owner's
 * local workspace databases leaves it in place and the install keeps its
 * address in the fleet. Rotate it only through a future explicit "reset this
 * install" affordance, never as a side effect of wiping data.
 */

import type { Brand } from 'wellcrafted/brand';
import { generateId } from '../shared/id.js';

/**
 * Branded string identifying one Epicenter app on one persistent storage
 * scope (one "node" in the user-facing presence vocabulary). Generated
 * by {@link createNodeId} or
 * {@link createNodeIdAsync}; brand prevents accidental mixing with
 * unrelated string ids (PrincipalId, AgentId, room ids, etc.).
 *
 * At trusted call sites that receive a known `string`, brand it with
 * {@link asNodeId}.
 */
export type NodeId = string & Brand<'NodeId'>;

/**
 * Syntactic sugar for `value as NodeId`. The function body is a single
 * typed cast; the constrained `string` parameter is what earns it over a
 * raw `as` (callers can't accidentally widen to `unknown`). The only place
 * in the codebase where `as NodeId` should appear.
 */
export const asNodeId = (value: string): NodeId => value as NodeId;

/** Storage primitive that mirrors the synchronous Web Storage shape. */
export type SimpleStorage = {
	getItem(key: string): string | null;
	setItem(key: string, value: string): void;
};

/** Storage primitive with the async shape (chrome.storage, IndexedDB wrappers). */
export type AsyncStorage = {
	getItem(key: string): Promise<string | null>;
	setItem(key: string, value: string): Promise<void>;
};

const KEY = 'epicenter.node.id';

/** Read or lazily generate the node id from synchronous storage. */
export function createNodeId({ storage }: { storage: SimpleStorage }): NodeId {
	const existing = storage.getItem(KEY);
	if (existing) return asNodeId(existing);
	const fresh = generateId<NodeId>();
	storage.setItem(KEY, fresh);
	return asNodeId(fresh);
}

/** Read or lazily generate the node id from async storage. */
export async function createNodeIdAsync({
	storage,
}: {
	storage: AsyncStorage;
}): Promise<NodeId> {
	const existing = await storage.getItem(KEY);
	if (existing) return asNodeId(existing);
	const fresh = generateId<NodeId>();
	await storage.setItem(KEY, fresh);
	return asNodeId(fresh);
}
