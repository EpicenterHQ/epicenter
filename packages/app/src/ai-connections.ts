export {
	type ConnectionCatalog,
	openAccountConnectionCatalog,
	openLocalConnectionCatalog,
} from './connection-catalog.js';

import { nanoid } from 'nanoid';
import { createLogger } from 'wellcrafted/logger';
import type { AiTransport } from './inference.js';

const log = createLogger('ai-connections');

export type CustomConnectionInput = {
	name?: string;
	baseUrl: string;
	apiKey?: string;
	models?: string[];
};

export type AiConnectionRecord = {
	id: string;
	name: string;
	baseUrl: string;
	apiKey?: string;
	models: string[];
};

/** A host snapshot omits its key and identifies the captured access revision. */
export type AiConnectionSnapshot = AiConnectionRecord & {
	hasApiKey?: boolean;
	accessVersion?: string;
};

/** Platform owner behind the public App connection collection. */
export type AiConnections = {
	signal: AbortSignal;
	ready?: Promise<void>;
	getAll(): readonly AiConnectionSnapshot[];
	subscribe(
		listener: (records: readonly AiConnectionSnapshot[]) => void,
	): () => void;
	add(input: CustomConnectionInput): Promise<string>;
	update(id: string, patch: Partial<CustomConnectionInput>): Promise<void>;
	remove(id: string): Promise<void>;
	reorder(ids: readonly string[]): Promise<void>;
	transport(record: AiConnectionSnapshot): AiTransport;
	close(): void | Promise<void>;
};

function invalid(): never {
	throw new Error('Invalid persisted App AI connections.');
}

/** Validate saved records without accepting workflow settings or minting IDs. */
export function validateAiConnectionRecords(
	value: unknown,
): AiConnectionRecord[] {
	if (!Array.isArray(value)) invalid();
	const records = value.map((value: unknown) => {
		if (!value || typeof value !== 'object' || Array.isArray(value)) invalid();
		const entry = value as Record<string, unknown>;
		if (
			Object.keys(entry).some(
				(key) => !['id', 'name', 'baseUrl', 'apiKey', 'models'].includes(key),
			) ||
			typeof entry.id !== 'string' ||
			!entry.id ||
			entry.id.startsWith('unresolved:') ||
			typeof entry.name !== 'string' ||
			typeof entry.baseUrl !== 'string' ||
			(entry.apiKey !== undefined && typeof entry.apiKey !== 'string') ||
			!Array.isArray(entry.models) ||
			entry.models.some((model) => typeof model !== 'string')
		)
			invalid();
		return {
			id: entry.id,
			name: entry.name,
			baseUrl: entry.baseUrl,
			...(entry.apiKey === undefined ? {} : { apiKey: entry.apiKey }),
			models: entry.models.map((model: string) => model),
		};
	});
	if (new Set(records.map(({ id }) => id)).size !== records.length) invalid();
	return records;
}

/** Parse the connection-only envelope. Errors never include saved credentials. */
export function parseAiConnections(raw: string) {
	let value: unknown;
	try {
		value = JSON.parse(raw);
	} catch {
		invalid();
	}
	if (!value || typeof value !== 'object' || Array.isArray(value)) invalid();
	const entry = value as Record<string, unknown>;
	if (
		entry.version !== 1 ||
		Object.keys(entry).some((key) => !['version', 'connections'].includes(key))
	)
		invalid();
	return {
		version: 1 as const,
		connections: validateAiConnectionRecords(entry.connections),
	};
}

function defaultName(baseUrl: string) {
	try {
		return new URL(baseUrl).host;
	} catch {
		return 'Connection';
	}
}

/** Owns device-local custom connection records for one App lifetime. */
export function createAiConnections({
	storage,
	storageKey,
	subscribeStorage,
	locks,
	publishStorage,
	fetch = globalThis.fetch.bind(globalThis),
}: {
	storage: Pick<Storage, 'getItem' | 'setItem'>;
	storageKey: string;
	subscribeStorage?: (listener: () => void) => () => void;
	locks?: Pick<LockManager, 'request'>;
	publishStorage?: () => void;
	fetch?: AiTransport['fetch'];
}) {
	const key = `${storageKey}.app-ai-connections`;
	const lifetime = new AbortController();
	let closed = false;
	let closing: Promise<void> | undefined;
	const pending = new Set<Promise<unknown>>();
	const listeners = new Set<(records: readonly AiConnectionRecord[]) => void>();
	let state = load();

	function load() {
		const raw = storage.getItem(key);
		if (raw !== null) return parseAiConnections(raw);
		return { version: 1 as const, connections: [] as AiConnectionRecord[] };
	}
	function assertOpen() {
		if (closed) throw new Error('App AI connections are closed.');
	}
	function notify() {
		for (const listener of listeners) {
			try {
				listener(structuredClone(state.connections));
			} catch (cause) {
				log.error(new Error('AI connection subscriber failed.', { cause }));
			}
		}
	}
	function commit(connections: AiConnectionRecord[]) {
		assertOpen();
		const next = {
			version: 1 as const,
			connections: validateAiConnectionRecords(connections),
		};
		storage.setItem(key, JSON.stringify(next));
		state = next;
		notify();
		publishStorage?.();
	}
	function mutate<T>(operation: () => T): Promise<T> {
		assertOpen();
		const run = async () => {
			assertOpen();
			state = load();
			return operation();
		};
		const result = Promise.resolve(
			locks
				? locks.request(
						`${storageKey}.app-ai-connections-write`,
						{ mode: 'exclusive' },
						run,
					)
				: run(),
		);
		pending.add(result);
		void result.then(
			() => pending.delete(result),
			() => pending.delete(result),
		);
		return result;
	}
	const unsubscribe = subscribeStorage?.(() => {
		if (closed) return;
		const raw = storage.getItem(key);
		const next =
			raw === null
				? { version: 1 as const, connections: [] }
				: parseAiConnections(raw);
		if (JSON.stringify(next) === JSON.stringify(state)) return;
		state = next;
		notify();
	});
	return {
		signal: lifetime.signal,
		transport(record: AiConnectionSnapshot): AiTransport {
			return { baseURL: record.baseUrl, fetch };
		},
		/** Detached saved fields, including explicit credentials; never sync or log them. */
		getAll(): readonly AiConnectionRecord[] {
			assertOpen();
			return structuredClone(state.connections);
		},
		add(input: CustomConnectionInput) {
			input = structuredClone(input);
			return mutate(() => {
				const id = nanoid();
				commit([
					...state.connections,
					{
						...input,
						id,
						name: input.name ?? defaultName(input.baseUrl),
						models: input.models ?? [],
					},
				]);
				return id;
			});
		},
		update(id: string, patch: Partial<CustomConnectionInput>) {
			patch = Object.fromEntries(
				Object.entries(structuredClone(patch)).filter(
					([, value]) => value !== undefined,
				),
			);
			return mutate(() => {
				if (!state.connections.some((entry) => entry.id === id))
					throw new Error('AI connection does not exist.');
				commit(
					state.connections.map((entry) =>
						entry.id === id ? { ...entry, ...patch, id } : entry,
					),
				);
			});
		},
		remove(id: string) {
			return mutate(() => {
				commit(state.connections.filter((entry) => entry.id !== id));
			});
		},
		reorder(ids: readonly string[]) {
			ids = [...ids];
			return mutate(() => {
				const entries = new Map(
					state.connections.map((entry) => [entry.id, entry]),
				);
				if (
					ids.length !== entries.size ||
					new Set(ids).size !== ids.length ||
					ids.some((id) => !entries.has(id))
				) {
					throw new Error(
						'AI connection order must contain each existing id once.',
					);
				}
				commit(ids.map((id) => entries.get(id)!));
			});
		},
		subscribe(listener: (records: readonly AiConnectionRecord[]) => void) {
			assertOpen();
			listeners.add(listener);
			try {
				listener(structuredClone(state.connections));
			} catch (cause) {
				listeners.delete(listener);
				throw cause;
			}
			return () => {
				listeners.delete(listener);
			};
		},
		close() {
			if (closing) return closing;
			closed = true;
			closing = Promise.allSettled(pending).then(() => {});
			lifetime.abort();
			listeners.clear();
			unsubscribe?.();
			return closing;
		},
	};
}
