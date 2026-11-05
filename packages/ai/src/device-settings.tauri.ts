/**
 * `#device-settings` in a desktop app: where a connection's key is kept.
 * The shell holds every key and sends each of a connection's requests with
 * it (`connectionFetch`), so the page never reads one: it hands a key to the
 * shell once, and `connections.md` records which endpoint it was entered
 * for. The browser's is `device-settings.ts`; the build picks one (the
 * `tauri` condition).
 */
import type { ConnectionKeys } from './device-settings.js';
import { custom } from './custom.js';
import { connectionFetch, keychain } from './tauri.js';

export type { ConnectionKeys } from './device-settings.js';

export const connectionKeys: ConnectionKeys = {
	// The page never holds a key.
	keyOf: () => undefined,
	// No key here: the shell adds the one it keeps for this connection.
	endpoint: (record) =>
		custom({
			id: record.id,
			name: record.name,
			baseUrl: record.baseUrl,
			fetch: connectionFetch(record.id),
			models: record.models,
		}),
	set: (id, endpoint, key) =>
		keychain.set(id, key === null ? null : JSON.stringify({ endpoint, key })),
	async move(id, from, to) {
		const text = (await keychain.get([id]))[id];
		if (text === undefined) return;
		const kept = JSON.parse(text) as { endpoint?: string; key?: string };
		if (kept.endpoint !== from || typeof kept.key !== 'string') return;
		await keychain.set(id, JSON.stringify({ endpoint: to, key: kept.key }));
	},
	subscribe: () => () => {},
};
