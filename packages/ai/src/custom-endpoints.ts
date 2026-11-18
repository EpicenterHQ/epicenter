/**
 * The person's connected endpoints as one live entry of `openAi([...])`:
 * the endpoint each saved connection makes, beside the actions that change
 * them. Where the list and the keys are kept is the app's: it passes a
 * `ConnectionStore` (each connection's id, name, base URL and models, and
 * the base URL its key was entered for, never the key) and a
 * `ConnectionKeys` (each key, by connection id). A key is read as each
 * request leaves and sent only while the connection is still at the base
 * URL it was entered for.
 *
 * The actions run one at a time, each over what the one before it left.
 */
import { nanoid } from 'nanoid';
import { custom } from './custom.js';
import type { Endpoint } from './endpoint.js';

/** What a person enters for a connection. */
export type CustomConnectionInput = {
	name?: string;
	baseUrl: string;
	apiKey?: string;
	models?: string[];
};

/** A connection as it is kept: `key` is the base URL its key was entered for, when it has one. */
export type ConnectionRecord = {
	id: string;
	name: string;
	baseUrl: string;
	models: string[];
	key?: string;
};

/** A connection as a picker shows it: whether a key applies to it. */
export type ConnectionSnapshot = Omit<ConnectionRecord, 'key'> & {
	hasApiKey: boolean;
};

/** Where the app keeps the list of connections. */
export type ConnectionStore = {
	/** The saved connections, in the person's order. */
	list(): readonly ConnectionRecord[];
	/** Why the saved connections do not read, or null; while they do not, none is merged. */
	problem(): { message: string } | null;
	/** Replace the list; rejects when it cannot be saved. */
	save(list: readonly ConnectionRecord[]): Promise<void>;
	/** Called when `list()` or `problem()` may answer differently; returns the unsubscribe. */
	subscribe(listener: () => void): () => void;
};

/** Where the app keeps each connection's key, by connection id. */
export type ConnectionKeys = {
	/** The key kept for connection `id`, or null. */
	get(id: string): Promise<string | null>;
	/** Keep `key` for connection `id`; null forgets it. Rejects when it cannot. */
	set(id: string, key: string | null): Promise<void>;
};

/** The person's connected endpoints, as `openAi` merges them and a picker changes them. */
export type CustomEndpoints = {
	/** The endpoint each saved connection makes, in the person's order. */
	endpoints(): readonly Endpoint[];
	/** Called when the connections, and so `endpoints()`, may have changed; returns the unsubscribe. */
	subscribe(listener: () => void): () => void;
	/** The saved connections, each saying whether a key applies to it. */
	list(): readonly ConnectionSnapshot[];
	/** Why the saved connections do not read, or null. While they do not, none is merged. */
	problem(): { message: string } | null;
	/** The `fetch` every connection sends with, for a picker trying a connection before it is saved. */
	readonly fetch?: (input: string, init?: RequestInit) => Promise<Response>;
	add(input: CustomConnectionInput): Promise<string>;
	update(id: string, patch: Partial<CustomConnectionInput>): Promise<void>;
	remove(id: string): Promise<void>;
	reorder(ids: readonly string[]): Promise<void>;
};

/** The entries `customEndpoints` made, so `openAi` can find the one it merged. */
const made = new WeakSet<object>();

/** Whether `entry` is the person's connected endpoints. */
export function isCustomEndpoints(entry: object): entry is CustomEndpoints {
	return made.has(entry);
}

function hostOf(baseUrl: string) {
	try {
		return new URL(baseUrl).host;
	} catch {
		return 'Connection';
	}
}

/** The person's connected endpoints, kept where `store` and `keys` keep them, as one entry of `openAi([...])`. */
export function customEndpoints({
	store,
	keys,
	fetch,
}: {
	store: ConnectionStore;
	keys: ConnectionKeys;
	/** What each request is sent with; the page's own `fetch` when absent. */
	fetch?: (input: string, init?: RequestInit) => Promise<Response>;
}): CustomEndpoints {
	/** The endpoint each record made, by the record, so one stays the same value while it does not change. */
	let byRecord: Map<string, Endpoint> = new Map();
	let shownRecords: readonly ConnectionRecord[] | null = null;
	let shownEndpoints: readonly Endpoint[] = [];

	function endpointOf(record: ConnectionRecord): Endpoint {
		const { id } = record;
		return custom({
			id,
			name: record.name,
			baseUrl: record.baseUrl,
			// A key applies only at the base URL it was entered for.
			key: record.key === record.baseUrl ? () => keys.get(id) : undefined,
			fetch,
			models: record.models,
		});
	}

	/** Changes run one at a time, each over what the one before it left. */
	let changing: Promise<unknown> = Promise.resolve();
	function change<T>(step: (current: ConnectionRecord[]) => Promise<T>) {
		const run = changing.then(() => {
			if (store.problem() === null) return step([...store.list()]);
			// Saving replaces a list that does not read.
			return step([]);
		});
		changing = run.catch(() => {});
		return run;
	}

	const entry: CustomEndpoints = {
		endpoints() {
			const now = store.problem() === null ? store.list() : [];
			if (now === shownRecords) return shownEndpoints;
			shownRecords = now;
			const kept = new Map<string, Endpoint>();
			shownEndpoints = now.map((record) => {
				const key = JSON.stringify(record);
				const endpoint = byRecord.get(key) ?? endpointOf(record);
				kept.set(key, endpoint);
				return endpoint;
			});
			byRecord = kept;
			return shownEndpoints;
		},
		subscribe: (listener) => store.subscribe(listener),
		list: () =>
			(store.problem() === null ? store.list() : []).map(
				({ key, ...record }) => ({
					...record,
					models: [...record.models],
					hasApiKey: key === record.baseUrl,
				}),
			),
		problem: () => store.problem(),
		fetch,
		add({ apiKey, ...input }) {
			return change(async (list) => {
				const record: ConnectionRecord = {
					id: nanoid(),
					name: input.name ?? hostOf(input.baseUrl),
					baseUrl: input.baseUrl,
					models: [...(input.models ?? [])],
				};
				if (apiKey?.trim()) {
					await keys.set(record.id, apiKey.trim());
					record.key = record.baseUrl;
				}
				await store.save([...list, record]);
				return record.id;
			});
		},
		update(id, { apiKey, ...patch }) {
			return change(async (list) => {
				const record = list.find((other) => other.id === id);
				if (!record) throw new Error('AI connection does not exist.');
				const next: ConnectionRecord = {
					...record,
					...Object.fromEntries(
						Object.entries(patch).filter(([, value]) => value !== undefined),
					),
					models: [...(patch.models ?? record.models)],
					id,
				};
				// A new key is kept for the base URL it was entered with; a base
				// URL changed here keeps the key that applied to it.
				if (apiKey !== undefined) {
					await keys.set(id, apiKey.trim() || null);
					if (apiKey.trim()) next.key = next.baseUrl;
					else delete next.key;
				} else if (record.key === record.baseUrl) next.key = next.baseUrl;
				await store.save(list.map((other) => (other.id === id ? next : other)));
			});
		},
		remove(id) {
			return change(async (list) => {
				await store.save(list.filter((other) => other.id !== id));
				await keys.set(id, null);
			});
		},
		reorder(ids) {
			const order = [...ids];
			return change(async (list) => {
				const byId = new Map(list.map((other) => [other.id, other]));
				if (
					order.length !== byId.size ||
					new Set(order).size !== order.length ||
					order.some((id) => !byId.has(id))
				)
					throw new Error(
						'AI connection order must contain each existing id once.',
					);
				await store.save(order.flatMap((id) => byId.get(id) ?? []));
			});
		},
	};
	made.add(entry);
	return entry;
}
