/**
 * This computer's connected endpoints in Vocab's desktop program
 * (`#platform/connections`'s desktop leaf). The list (each endpoint's name,
 * URL, and models) is kept in the window's storage as in the browser; each
 * API key is kept in the keychain instead (`src-tauri/src/keychain.rs`),
 * saved with the endpoint it was entered for, and applied only while the
 * connection still names that endpoint (ADR-0564: an endpoint is stored
 * with its key), so a list changed behind the app's back cannot send a key
 * somewhere else.
 */
import {
	type AiConnections,
	type CustomConnectionInput,
	createAiConnections,
	openConnectionCatalog,
} from '@epicenter/ai/connections';
import { invoke } from '@tauri-apps/api/core';
import type { OpenConnections } from './types.js';

/** What the keychain keeps for one connection. */
type SavedKey = { endpoint: string; key: string };

/** The keychain as the connections reach it; tests stand in for it. */
export type ConnectionKeys = {
	/** The saved entries of `ids`, by id; an id with none is absent. */
	read(ids: string[]): Promise<Record<string, string>>;
	/** Save an entry, or remove it for `null`. */
	write(id: string, value: string | null): Promise<void>;
};

const keychain: ConnectionKeys = {
	read: (ids) => invoke('connection_keys', { ids }),
	write: (id, value) => invoke('set_connection_key', { id, value }),
};

function parseSaved(text: string): SavedKey | undefined {
	try {
		const value = JSON.parse(text) as Partial<SavedKey>;
		if (typeof value.endpoint === 'string' && typeof value.key === 'string')
			return { endpoint: value.endpoint, key: value.key };
	} catch {}
	return undefined;
}

/**
 * Connections whose records live in `list` (which never holds a key) and
 * whose keys live in `keys`.
 */
export function createKeychainConnections(
	keys: ConnectionKeys,
	list: AiConnections = createAiConnections({
		storage: window.localStorage,
		storageKey: 'epicenter/ai',
	}),
): AiConnections {
	const saved = new Map<string, SavedKey>();
	const listeners = new Set<Parameters<AiConnections['subscribe']>[0]>();

	function withKeys() {
		return list.getAll().map(({ apiKey: _none, ...record }) => {
			const entry = saved.get(record.id);
			return entry && entry.endpoint === record.baseUrl
				? { ...record, apiKey: entry.key }
				: record;
		});
	}
	function emit() {
		const records = withKeys();
		for (const listener of listeners) listener(records);
	}
	async function save(id: string, endpoint: string, key: string | undefined) {
		if (key?.trim()) {
			const entry = { endpoint, key };
			await keys.write(id, JSON.stringify(entry));
			saved.set(id, entry);
		} else {
			await keys.write(id, null);
			saved.delete(id);
		}
	}

	const ready = (async () => {
		await list.ready;
		const found = await keys.read(list.getAll().map(({ id }) => id));
		for (const [id, text] of Object.entries(found)) {
			const entry = parseSaved(text);
			if (entry) saved.set(id, entry);
		}
	})();
	const unsubscribe = list.subscribe(() => emit());

	return {
		signal: list.signal,
		ready,
		getAll: withKeys,
		subscribe(listener) {
			listeners.add(listener);
			listener(withKeys());
			return () => {
				listeners.delete(listener);
			};
		},
		async add({ apiKey, ...input }: CustomConnectionInput) {
			const id = await list.add(input);
			if (apiKey === undefined) return id;
			try {
				await save(id, input.baseUrl, apiKey);
			} catch (cause) {
				// A connection without the key it was added with is not kept.
				await list.remove(id);
				throw cause;
			}
			emit();
			return id;
		},
		async update(id, { apiKey, ...patch }) {
			const record = list.getAll().find((entry) => entry.id === id);
			if (!record) throw new Error('AI connection does not exist.');
			const endpoint = patch.baseUrl ?? record.baseUrl;
			// A new key is saved for the endpoint it was entered with; an
			// endpoint changed here keeps the key the person already gave it.
			if (apiKey !== undefined) await save(id, endpoint, apiKey);
			else if (endpoint !== record.baseUrl && saved.has(id))
				await save(id, endpoint, saved.get(id)?.key);
			await list.update(id, patch);
			emit();
		},
		async remove(id) {
			await list.remove(id);
			await save(id, '', undefined);
			emit();
		},
		reorder: (ids) => list.reorder(ids),
		transport: (record) => list.transport(record),
		close() {
			unsubscribe();
			listeners.clear();
			return list.close();
		},
	};
}

export const openConnections: OpenConnections = () =>
	openConnectionCatalog(createKeychainConnections(keychain));
