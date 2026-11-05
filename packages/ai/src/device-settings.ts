/**
 * `#device-settings` in a browser: where a connection's key is kept. On the
 * web the page holds it: `connection-keys.json` in this computer's settings
 * (this browser's storage for the site) keeps each connection's key and the
 * endpoint it was entered for, and a request carries it from the page. The
 * desktop's is `device-settings.tauri.ts`, where the shell holds the keys;
 * the build picks one (the `tauri` condition).
 */
import { settings } from '@epicenter/local';
import { custom } from './custom.js';
import type { ConnectionRecord } from './custom-endpoints.js';
import type { Endpoint } from './endpoint.js';

/** Where the keys of the person's connections are kept, and how a request carries one. */
export type ConnectionKeys = {
	/** The key that applies to `record`, when the page holds it: the web's only. */
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

const file = settings.file('connection-keys.json');

type Saved = Record<string, { endpoint: string; key: string }>;

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

export const connectionKeys: ConnectionKeys = {
	keyOf(record) {
		const kept = saved()[record.id];
		return kept?.endpoint === record.baseUrl ? kept.key : undefined;
	},
	endpoint(record) {
		return custom({
			id: record.id,
			name: record.name,
			baseUrl: record.baseUrl,
			key: connectionKeys.keyOf(record),
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
