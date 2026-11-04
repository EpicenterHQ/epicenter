/**
 * The person's connected endpoints as one live entry of `openAi([...])`:
 * the endpoints their saved connections make, read again whenever one is
 * added, edited or removed, beside the actions that change them. Where the
 * connections are kept is the build's (`customEndpoints()` from
 * `@epicenter/ai`); this turns any store of them into the entry.
 */
import { extractErrorMessage } from 'wellcrafted/error';
import { createLogger } from 'wellcrafted/logger';
import type {
	AiConnectionSnapshot,
	AiConnections,
	CustomConnectionInput,
} from './ai-connections.js';
import type { Endpoint } from './endpoint.js';

const log = createLogger('ai/custom-endpoints');

/** The person's connected endpoints, as `openAi` merges them and a picker changes them. */
export type CustomEndpoints = {
	/** The endpoint each saved connection makes, in the person's order; none until they are read. */
	endpoints(): readonly Endpoint[];
	/** Called when the connections, and so `endpoints()`, may have changed; returns the unsubscribe. */
	subscribe(listener: () => void): () => void;
	/** The saved connections, each saying whether a key applies to it. */
	list(): readonly AiConnectionSnapshot[];
	/** Why the saved connections could not be read, or null. While it is set, none is merged. */
	problem(): string | null;
	/** Settles once the saved connections were read, or could not be. */
	readonly ready: Promise<void>;
	/** Read the saved connections again, as after a failed read. */
	reopen(): Promise<void>;
	add(input: CustomConnectionInput): Promise<string>;
	update(id: string, patch: Partial<CustomConnectionInput>): Promise<void>;
	remove(id: string): Promise<void>;
	/** Stop following the saved connections. */
	close(): Promise<void>;
};

/** The entries `customEndpointsOf` made, so `openAi` can find the one it merged. */
const made = new WeakSet<object>();

/** Whether `entry` is the person's connected endpoints. */
export function isCustomEndpoints(entry: object): entry is CustomEndpoints {
	return made.has(entry);
}

/**
 * The live entry over the store `open` answers. Until it answers, and while
 * it cannot be opened, the entry lists no endpoint and `problem()` says why.
 * An endpoint stays the same value while its connection does not change.
 */
export function customEndpointsOf(
	open: () => Promise<AiConnections>,
): CustomEndpoints {
	let store: AiConnections | null = null;
	let records: readonly AiConnectionSnapshot[] = [];
	let merged: readonly Endpoint[] = [];
	let problem: string | null = null;
	let stopRecords: (() => void) | undefined;
	let closed = false;
	let attempt = 0;
	const listeners = new Set<() => void>();
	/** The endpoint each record made, by the record's saved fields. */
	const cache = new Map<string, Endpoint>();

	function notify() {
		for (const listener of [...listeners]) {
			try {
				listener();
			} catch (cause) {
				log.error(
					new Error('A custom endpoints subscriber failed.', { cause }),
				);
			}
		}
	}

	function adopt(next: readonly AiConnectionSnapshot[]) {
		records = next;
		const opened = store;
		const kept = new Map<string, Endpoint>();
		merged = opened
			? next.map((record) => {
					const key = JSON.stringify(record);
					const endpoint = cache.get(key) ?? opened.endpoint(record);
					kept.set(key, endpoint);
					return endpoint;
				})
			: [];
		cache.clear();
		for (const [key, endpoint] of kept) cache.set(key, endpoint);
		notify();
	}

	async function reopen() {
		const current = ++attempt;
		try {
			const opened = await open();
			if (closed || current !== attempt) {
				await opened.close();
				return;
			}
			stopRecords?.();
			const previous = store;
			store = opened;
			problem = null;
			cache.clear();
			stopRecords = opened.subscribe(adopt);
			void previous?.close();
		} catch (cause) {
			if (closed || current !== attempt) return;
			problem = extractErrorMessage(cause);
			notify();
		}
	}

	function opened(): AiConnections {
		if (!store)
			throw new Error(
				problem
					? `The saved connections could not be read: ${problem}`
					: 'The saved connections are not read yet.',
			);
		return store;
	}

	const entry: CustomEndpoints = {
		endpoints: () => merged,
		subscribe(listener) {
			listeners.add(listener);
			return () => {
				listeners.delete(listener);
			};
		},
		list: () => records,
		problem: () => problem,
		ready: reopen(),
		reopen,
		add: async (input) => opened().add(input),
		update: async (id, patch) => opened().update(id, patch),
		remove: async (id) => opened().remove(id),
		async close() {
			closed = true;
			stopRecords?.();
			listeners.clear();
			await store?.close();
		},
	};
	made.add(entry);
	return entry;
}
