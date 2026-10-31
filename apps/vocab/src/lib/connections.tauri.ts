/**
 * `#platform/connections` in Vocab's desktop window: the endpoints a learner
 * connected on this computer. The list (each endpoint's id, name, base URL
 * and models) is `connections.md` at the top of the AppData root, beside
 * `settings.md`: machine-local, never synced, read and written through
 * Vocab's settings contract (`vocabSettings`). Each API key is in the
 * keychain under the connection's id (`keychain` from
 * `@epicenter/auth/tauri`), saved with the endpoint it was entered for
 * (ADR-0564: an endpoint is stored with its key). Nothing about connections
 * is in the data folder, which Epicenter syncs, or in `settings.md`.
 *
 * A connection's requests are sent by the shell (`connectionFetch`), not by
 * this page: no endpoint needs to allow the window's origin (CORS), and the
 * shell adds the key itself and sends only to the origin of the endpoint
 * the key was saved for. So a `connections.md` changed behind the app's back
 * cannot send a key somewhere else, and no record here carries a key; a
 * record says only whether its key applies (`hasApiKey`).
 */
import {
	type AiConnectionRecord,
	type AiConnectionSnapshot,
	type AiConnections,
	type CustomConnectionInput,
	openConnectionCatalog,
} from '@epicenter/ai/connections';
import type { AuthFetch } from '@epicenter/auth';
import { connectionFetch, keychain } from '@epicenter/auth/tauri';
import type { Client, Version } from '@epicenter/definition/contract';
import { nanoid } from '@epicenter/definition/ids';
import { openAppData } from '@epicenter/folder/tauri';
import { createLogger } from 'wellcrafted/logger';
import { type VocabSettings, vocabSettings } from './folder.tauri.js';
import type { OpenConnections } from './platform.js';

const log = createLogger('vocab-connections');

/** `connections.md`'s client. */
export type ConnectionsFile = Client<VocabSettings>['connections'];

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
 * are in `keys`; `send` is the `fetch` of one connection by its id. Every
 * change reads the note again and writes over the version it read, one
 * change at a time, so a write never lands on a list it did not see.
 */
export function createKeychainConnections({
	file,
	keys,
	send = (id) => connectionFetch(id),
}: {
	file: ConnectionsFile;
	keys: ConnectionKeys;
	send?: (id: string) => AuthFetch;
}): AiConnections {
	const lifetime = new AbortController();
	let records: AiConnectionRecord[] = [];
	/** The endpoint each saved key was entered for, by connection id. */
	const keyed = new Map<string, string>();
	const listeners = new Set<
		(records: readonly AiConnectionSnapshot[]) => void
	>();
	let queue: Promise<unknown> = Promise.resolve();
	let closed = false;

	/** The records, each saying whether its saved key applies to it. */
	function snapshots(): AiConnectionSnapshot[] {
		return records.map((record) => ({
			...record,
			models: [...record.models],
			hasApiKey: keyed.get(record.id) === record.baseUrl,
		}));
	}
	function emit() {
		const current = snapshots();
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

	/** The saved key of each of `ids` that has one. */
	async function readSaved(ids: string[]): Promise<Map<string, SavedKey>> {
		const found = new Map<string, SavedKey>();
		if (ids.length === 0) return found;
		for (const [id, text] of Object.entries(await keys.get(ids))) {
			const entry = parseSaved(text);
			if (entry) found.set(id, entry);
		}
		return found;
	}

	/** Learn which endpoint the keys of the connections not read yet were saved for. */
	async function readKeyed(ids: string[]) {
		const unread = ids.filter((id) => !keyed.has(id));
		for (const [id, { endpoint }] of await readSaved(unread))
			keyed.set(id, endpoint);
	}

	/** Save `key` for `id` at `endpoint`, or remove it when there is none. */
	async function saveKey(id: string, endpoint: string, key?: string) {
		if (key?.trim()) {
			await keys.set(id, JSON.stringify({ endpoint, key } satisfies SavedKey));
			keyed.set(id, endpoint);
		} else {
			await keys.set(id, null);
			keyed.delete(id);
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
			await readKeyed(list.map(({ id }) => id));
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
		getAll: snapshots,
		subscribe(listener) {
			listeners.add(listener);
			listener(snapshots());
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
				if (apiKey !== undefined) await saveKey(id, next.baseUrl, apiKey);
				else if (
					next.baseUrl !== record.baseUrl &&
					keyed.get(id) === record.baseUrl
				) {
					const entry = (await readSaved([id])).get(id);
					if (entry?.endpoint === record.baseUrl)
						await saveKey(id, next.baseUrl, entry.key);
				}
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
		transport: (record) => ({
			baseURL: record.baseUrl,
			fetch: send(record.id),
		}),
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
	const opened = await openAppData(vocabSettings);
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
