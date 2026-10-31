/**
 * `#platform/connections` in Vocab's desktop window: the endpoints a learner
 * connected on this computer. The list (each endpoint's id, name, base URL
 * and models) is `connections.md` at the top of the AppData root, beside
 * `settings.md`: machine-local, never synced, read and written through its
 * own contract's client. Each API key is in the keychain under the
 * connection's id (`keychain` from `@epicenter/auth/tauri`), saved with the
 * endpoint it was entered for and applied only while the connection still
 * names that endpoint (ADR-0564: an endpoint is stored with its key), so a
 * `connections.md` changed behind the app's back cannot send a key
 * somewhere else. Nothing about connections is in the data folder, which
 * Epicenter syncs, or in `settings.md`.
 */
import {
	type AiConnectionRecord,
	type AiConnectionSnapshot,
	type AiConnections,
	type CustomConnectionInput,
	openConnectionCatalog,
} from '@epicenter/ai/connections';
import { keychain } from '@epicenter/auth/tauri';
import {
	type Client,
	defineContract,
	type Version,
} from '@epicenter/definition/contract';
import { nanoid } from '@epicenter/definition/ids';
import { openDevice } from '@epicenter/folder/tauri';
import { appDataDir } from '@tauri-apps/api/path';
import { createLogger } from 'wellcrafted/logger';
import type { OpenConnections } from './platform.js';

const log = createLogger('vocab-connections');

/**
 * The AppData root's `connections.md`: one note whose `connections` list is
 * the connected endpoints in the learner's order, never a key. An id is the
 * name its key is kept under in the keychain, so it is a keychain name.
 */
export const machineConnections = defineContract({
	name: 'vocab-connections',
	description:
		"Vocab's connected endpoints on this computer, never synced: each one's id, name, base URL and models. Their keys are in the keychain.",
	collections: {
		connections: {
			path: 'connections.md',
			fields: {
				connections: {
					type: 'array',
					items: {
						type: 'object',
						properties: {
							id: { type: 'string', pattern: '^[A-Za-z0-9_-]{1,64}$' },
							name: { type: 'string' },
							baseUrl: { type: 'string' },
							models: { type: 'array', items: { type: 'string' } },
						},
						required: ['id', 'name', 'baseUrl', 'models'],
					},
				},
			},
			required: ['connections'],
		},
	},
});

/** `connections.md`'s client. */
export type ConnectionsFile = Client<typeof machineConnections>['connections'];

/** The keychain as the connections reach it (`keychain`); tests stand in for it. */
export type ConnectionKeys = {
	/** The saved entries among `names`, by name; a name with none is absent. */
	get(names: string[]): Promise<Record<string, string>>;
	/** Save the entry `name`, or remove it for `null`. */
	set(name: string, value: string | null): Promise<void>;
};

/** What the keychain keeps for one connection: its key, and the endpoint it was entered for. */
type SavedKey = { endpoint: string; key: string };

function parseSaved(text: string): SavedKey | undefined {
	try {
		const value = JSON.parse(text) as Partial<SavedKey>;
		if (typeof value.endpoint === 'string' && typeof value.key === 'string')
			return { endpoint: value.endpoint, key: value.key };
	} catch {}
	return undefined;
}

/** `connections.md` as read: its records, and the version to write over (null while it does not exist). */
type Listed = { list: AiConnectionRecord[]; version: Version | null };

/**
 * Connections whose list is `file` (which never holds a key) and whose keys
 * are in `keys`. Every change reads the note again and writes over the
 * version it read, one change at a time, so a write never lands on a list
 * it did not see.
 */
export function createKeychainConnections({
	file,
	keys,
	fetch = globalThis.fetch.bind(globalThis),
}: {
	file: ConnectionsFile;
	keys: ConnectionKeys;
	fetch?: typeof globalThis.fetch;
}): AiConnections {
	const lifetime = new AbortController();
	let records: AiConnectionRecord[] = [];
	const saved = new Map<string, SavedKey>();
	const listeners = new Set<
		(records: readonly AiConnectionSnapshot[]) => void
	>();
	let queue: Promise<unknown> = Promise.resolve();
	let closed = false;

	function withKeys(): AiConnectionSnapshot[] {
		return records.map((record) => {
			const entry = saved.get(record.id);
			return entry?.endpoint === record.baseUrl
				? { ...record, models: [...record.models], apiKey: entry.key }
				: { ...record, models: [...record.models] };
		});
	}
	function emit() {
		const current = withKeys();
		for (const listener of listeners) listener(current);
	}

	async function read(): Promise<Listed> {
		const note = await file.get({});
		if (note.error?.name === 'NotFound') return { list: [], version: null };
		if (note.error !== null)
			throw new Error(
				`Vocab's connections.md could not be read: ${note.error.message}`,
				{ cause: note.error },
			);
		return {
			list: note.data.connections.map(({ id, name, baseUrl, models }) => ({
				id,
				name,
				baseUrl,
				models: [...models],
			})),
			version: note.data.version,
		};
	}

	async function write(list: AiConnectionRecord[], version: Version | null) {
		const connections = list.map(({ id, name, baseUrl, models }) => ({
			id,
			name,
			baseUrl,
			models,
		}));
		const written =
			version === null
				? await file.create({ connections })
				: await file.update({}, { connections }, { over: version });
		if (written.error !== null)
			throw new Error(
				`Vocab's connections.md could not be saved: ${written.error.message}`,
				{ cause: written.error },
			);
		records = list;
	}

	/** Read the keys of the connections not read yet. */
	async function readKeys(ids: string[]) {
		const unread = ids.filter((id) => !saved.has(id));
		if (unread.length === 0) return;
		const found = await keys.get(unread);
		for (const [id, text] of Object.entries(found)) {
			const entry = parseSaved(text);
			if (entry) saved.set(id, entry);
		}
	}

	/** Save `key` for `id` at `endpoint`, or remove it when there is none. */
	async function saveKey(id: string, endpoint: string, key?: string) {
		if (key?.trim()) {
			const entry = { endpoint, key };
			await keys.set(id, JSON.stringify(entry));
			saved.set(id, entry);
		} else {
			await keys.set(id, null);
			saved.delete(id);
		}
	}

	/** Run `step` after every earlier one. */
	function serially<T>(step: () => Promise<T>): Promise<T> {
		const run = queue.then(step);
		queue = run.catch(() => {});
		return run;
	}

	/** Change the list as it is in the file now, after every earlier change. */
	function change<T>(step: (current: Listed) => Promise<T>): Promise<T> {
		if (closed) return Promise.reject(new Error('Connections are closed.'));
		return serially(async () => {
			const result = await step(await read());
			emit();
			return result;
		});
	}

	/** Take the file as it is now, with the keys of any connection new to it. */
	const refresh = () =>
		serially(async () => {
			const { list } = await read();
			await readKeys(list.map(({ id }) => id));
			records = list;
			emit();
		});

	const ready = refresh();
	// Another window, an agent, or a person may change the note.
	const unsubscribe = file.subscribe(() => {
		if (closed) return;
		void refresh().catch((cause) => log.warn(cause));
	});

	return {
		signal: lifetime.signal,
		ready,
		getAll: withKeys,
		subscribe(listener) {
			listeners.add(listener);
			listener(withKeys());
			return () => {
				listeners.delete(listener);
			};
		},
		add({ apiKey, ...input }: CustomConnectionInput) {
			return change(async ({ list, version }) => {
				const record: AiConnectionRecord = {
					id: nanoid(),
					name: input.name ?? hostOf(input.baseUrl),
					baseUrl: input.baseUrl,
					models: [...(input.models ?? [])],
				};
				await write([...list, record], version);
				if (apiKey === undefined) return record.id;
				try {
					await saveKey(record.id, record.baseUrl, apiKey);
				} catch (cause) {
					// A connection without the key it was added with is not kept.
					const { list: now, version: over } = await read();
					await write(
						now.filter(({ id }) => id !== record.id),
						over,
					);
					throw cause;
				}
				return record.id;
			});
		},
		update(id, { apiKey, ...patch }) {
			const defined = Object.fromEntries(
				Object.entries(patch).filter(([, value]) => value !== undefined),
			) as Partial<Omit<CustomConnectionInput, 'apiKey'>>;
			return change(async ({ list, version }) => {
				const record = list.find((entry) => entry.id === id);
				if (!record) throw new Error('AI connection does not exist.');
				const next: AiConnectionRecord = {
					...record,
					...defined,
					models: [...(defined.models ?? record.models)],
					id,
				};
				// A new key is saved for the endpoint it was entered with; an
				// endpoint changed here keeps the key that applied to it.
				const entry = saved.get(id);
				if (apiKey !== undefined) await saveKey(id, next.baseUrl, apiKey);
				else if (
					next.baseUrl !== record.baseUrl &&
					entry?.endpoint === record.baseUrl
				)
					await saveKey(id, next.baseUrl, entry.key);
				await write(
					list.map((other) => (other.id === id ? next : other)),
					version,
				);
			});
		},
		remove(id) {
			return change(async ({ list, version }) => {
				await write(
					list.filter((entry) => entry.id !== id),
					version,
				);
				await saveKey(id, '');
			});
		},
		reorder(ids) {
			const order = [...ids];
			return change(async ({ list, version }) => {
				const byId = new Map(list.map((entry) => [entry.id, entry]));
				if (
					order.length !== byId.size ||
					new Set(order).size !== order.length ||
					order.some((id) => !byId.has(id))
				)
					throw new Error(
						'AI connection order must contain each existing id once.',
					);
				await write(
					order.flatMap((id) => byId.get(id) ?? []),
					version,
				);
			});
		},
		transport: (record) => ({ baseURL: record.baseUrl, fetch }),
		async close() {
			closed = true;
			unsubscribe();
			lifetime.abort();
			listeners.clear();
			await queue;
		},
	};
}

function hostOf(baseUrl: string) {
	try {
		return new URL(baseUrl).host;
	} catch {
		return 'Connection';
	}
}

export const openConnections: OpenConnections = async () => {
	let path: string;
	try {
		path = await appDataDir();
	} catch (cause) {
		throw new Error("Vocab's AppData folder could not be found.", { cause });
	}
	const opened = await openDevice(machineConnections, { path });
	if (opened.error !== null)
		throw new Error(
			`Vocab's connections could not be opened: ${opened.error.message}`,
			{ cause: opened.error },
		);
	return openConnectionCatalog(
		createKeychainConnections({
			file: opened.data.connections,
			keys: keychain,
		}),
	);
};
