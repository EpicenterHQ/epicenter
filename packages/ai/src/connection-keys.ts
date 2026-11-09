/**
 * Where a connection's key is kept, and how a request carries it, chosen
 * when this module loads with `isTauri()` (ADR-0781).
 *
 * - In a Tauri window the shell holds every key and sends each of a
 *   connection's requests with it (`connectionFetch` in `tauri.ts`, loaded
 *   with the first request or key change), so the page never reads one: it
 *   hands a key to the shell once, and `connections.md` records which
 *   endpoint it was entered for.
 * - In a browser the page holds it: `connection-keys.json` in this
 *   computer's settings (this browser's storage for the site) keeps each
 *   connection's key and the endpoint it was entered for, and a request
 *   carries it from the page.
 */
import { settings } from '@epicenter/local';
import { isTauri } from '@tauri-apps/api/core';
import { custom } from './custom.js';
import type { ConnectionRecord } from './custom-endpoints.js';
import type { Endpoint } from './endpoint.js';

/** Where the keys of the person's connections are kept, and how a request carries one. */
export type ConnectionKeys = {
	/** Whether the shell keeps each key and sends each request (`CustomEndpoints.relayed`). */
	readonly relayed: boolean;
	/** The key that applies to `record`, when the page holds it: a browser's only. */
	keyOf(record: ConnectionRecord): string | undefined;
	/** The endpoint `record` makes, sending with the key kept for it. */
	endpoint(record: ConnectionRecord): Endpoint;
	/** Keep `key` for connection `id`, entered for `endpoint`; null forgets it. */
	set(id: string, endpoint: string, key: string | null): Promise<void>;
	/** The key kept for `id`, entered for `from`, applies to `to` from now. */
	move(id: string, from: string, to: string): Promise<void>;
	/** Call `listener` when a key may have changed; returns the unsubscribe. */
	subscribe(listener: () => void): () => void;
};

/** The shell's keys: none in the page, each request sent by the shell. */
function shellKeys(): ConnectionKeys {
	const shell = () => import('./tauri.js');
	return {
		relayed: true,
		// The page never holds a key.
		keyOf: () => undefined,
		// No key here: the shell adds the one it keeps for this connection.
		endpoint: (record) =>
			custom({
				id: record.id,
				name: record.name,
				baseUrl: record.baseUrl,
				fetch: async (input, init) =>
					(await shell()).connectionFetch(record.id)(input, init),
				models: record.models,
			}),
		set: async (id, endpoint, key) =>
			(await shell()).connectionKey.set(id, endpoint, key),
		move: async (id, from, to) =>
			(await shell()).connectionKey.move(id, from, to),
		subscribe: () => () => {},
	};
}

type Saved = Record<string, { endpoint: string; key: string }>;

/** The page's keys: `connection-keys.json` in this computer's settings. */
function pageKeys(): ConnectionKeys {
	const file = settings.file('connection-keys.json');

	/** Every kept key by connection id; a file that does not read keeps none. */
	function saved(): Saved {
		const text = file.text();
		if (text === null) return {};
		try {
			const value: unknown = JSON.parse(text);
			return value && typeof value === 'object' && !Array.isArray(value)
				? (value as Saved)
				: {};
		} catch {
			return {};
		}
	}

	async function keep(next: Saved) {
		await file.write(Object.keys(next).length ? JSON.stringify(next) : null);
	}

	const keys: ConnectionKeys = {
		relayed: false,
		keyOf(record) {
			const kept = saved()[record.id];
			return kept?.endpoint === record.baseUrl ? kept.key : undefined;
		},
		endpoint(record) {
			return custom({
				id: record.id,
				name: record.name,
				baseUrl: record.baseUrl,
				key: keys.keyOf(record),
				models: record.models,
			});
		},
		async set(id, endpoint, key) {
			await file.connected();
			const next = { ...saved() };
			if (key === null) delete next[id];
			else next[id] = { endpoint, key };
			await keep(next);
		},
		async move(id, from, to) {
			await file.connected();
			const kept = saved()[id];
			if (kept?.endpoint !== from) return;
			await keep({ ...saved(), [id]: { endpoint: to, key: kept.key } });
		},
		subscribe: (listener) => file.subscribe(listener),
	};
	return keys;
}

export const connectionKeys: ConnectionKeys = isTauri()
	? shellKeys()
	: pageKeys();
