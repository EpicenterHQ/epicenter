/**
 * `@epicenter/ai/tauri`: the person's provider keys in a standalone desktop
 * app, and the requests sent with them. The keys belong to the custom
 * endpoints they unlock, so they live here and not with the account.
 *
 * - `keychain`: the shell's credential store, where each key is saved under
 *   a name of the page's own (`keychain_get`, `keychain_set` in
 *   `epicenter-account`). The page writes a key and never reads one back to
 *   send it.
 * - `connectionFetch(id)`: the `fetch` of one connected endpoint. The shell
 *   (`connection_fetch`) reads the key saved under `id`, adds it, and sends
 *   only to the endpoint it was saved for, so the page never holds the key
 *   and no endpoint needs to allow the window's origin (CORS). A connection
 *   with no saved key is sent with none.
 * - `shellFetch`: the same fetch with no connection and so no key, for a
 *   server on this computer (Ollama, LM Studio), which answers no
 *   `tauri://` page.
 * - `createKeychainConnections`: the connected endpoints, their list in an
 *   AppData note shaped by `connectionsCollection` and each key in the
 *   keychain, as an `AiConnections` an app merges with `openAi`.
 */

import {
	messageOf,
	relayThroughShell,
	type ShellRelay,
	type TauriShell,
	tauriShell,
} from '@epicenter/account/tauri';
import type { NoteClient, Version } from '@epicenter/definition/contract';
import { nanoid } from 'nanoid';
import { defineErrors, type InferErrors } from 'wellcrafted/error';
import { createLogger } from 'wellcrafted/logger';
import type {
	AiConnectionRecord,
	AiConnectionSnapshot,
	AiConnections,
	CustomConnectionInput,
} from './ai-connections.js';
import { custom } from './custom.js';

const log = createLogger('ai/tauri');

/** A Fetch API function, as an endpoint sends with it. */
type Send = (input: string, init?: RequestInit) => Promise<Response>;

/**
 * Why the shell did not send a connection's request, or why its answer
 * ended early (`ConnectionFetchError` in `connection.rs`).
 */
export const ConnectionFetchError = defineErrors({
	/** The request does not read, or carried a credential of the page's. */
	InvalidRequest: ({ message }: { message: string }) => ({ message }),
	/** Neither `https`, nor `http` to `localhost` or `127.0.0.1`. */
	SchemeRefused: ({ message }: { message: string }) => ({ message }),
	/** Not on the origin of the endpoint the connection's key was saved for. */
	OriginRefused: ({ message }: { message: string }) => ({ message }),
	/** The keychain could not be read. */
	KeychainFailed: ({ message }: { message: string }) => ({ message }),
	/** The endpoint could not be reached, or its answer broke off. */
	SendFailed: ({ message }: { message: string }) => ({ message }),
});
export type ConnectionFetchError = InferErrors<typeof ConnectionFetchError>;

/** The shell's `ConnectionFetchError` as this page's, or a `TypeError` for anything else. */
function connectionFailure(cause: unknown) {
	const name =
		cause && typeof cause === 'object' && 'name' in cause
			? String(cause.name)
			: '';
	if (Object.hasOwn(ConnectionFetchError, name))
		return ConnectionFetchError[name as ConnectionFetchError['name']]({
			message: messageOf(cause),
		}).error;
	return new TypeError(messageOf(cause));
}

/**
 * The `fetch` of one connected endpoint (`connection` is its id): each
 * request goes to the shell, which reads the key the keychain keeps for the
 * connection, sends the request only to the endpoint that key was saved for
 * and with the key, and streams the answer back. The page sends no
 * credential, and no endpoint needs to allow this window's origin (CORS). A
 * refusal rejects with a {@link ConnectionFetchError}, as `fetch` rejects.
 * With `null` the shell sends with no key, as {@link shellFetch} does.
 */
export function connectionFetch(
	connection: string | null,
	shell: TauriShell = tauriShell,
): Send {
	const relay: ShellRelay = {
		fetch: 'connection_fetch',
		cancel: 'connection_fetch_cancel',
		fields: { connection },
		failure: connectionFailure,
	};
	return (input, init) =>
		relayThroughShell(shell, relay, new Request(input, init));
}

/**
 * The shell's fetch with no key: `https` anywhere, or `http` to `localhost`
 * or `127.0.0.1`, streamed back like a connection's. How a desktop app
 * reaches a server on this computer, which answers no `tauri://` page.
 */
export const shellFetch: Send = (input, init) =>
	connectionFetch(null)(input, init);

/** The keychain as the connections reach it; tests stand in for it. */
export type ConnectionKeys = {
	/** The saved entries among `names`, by name; a name with none is absent. */
	get(names: string[]): Promise<Record<string, string>>;
	/** Save the entry `name`, or remove it for `null`. */
	set(name: string, value: string | null): Promise<void>;
};

/**
 * The keys a page saves in the keychain under names of its own (a
 * connection's id): letters, digits, `_` and `-`.
 */
export const keychain = {
	get: (names: string[], shell: TauriShell = tauriShell) =>
		shell.invoke<Record<string, string>>('keychain_get', { names }),
	set: (name: string, value: string | null, shell: TauriShell = tauriShell) =>
		shell.invoke<void>('keychain_set', { name, value }),
} satisfies ConnectionKeys;

/**
 * The note that lists a desktop app's connected endpoints in its AppData
 * root, never synced: each one's id, name, base URL and models, in the
 * person's order, and never a key. An id is also the keychain name its key
 * is saved under. `customEndpoints()` keeps it through `@epicenter/local`.
 */
export const connectionsCollection = {
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
} as const;

/** The note client of an app's `connections.md`: as much as the connections read and write. */
export type ConnectionsFile = Pick<
	NoteClient<typeof connectionsCollection>,
	'get' | 'create' | 'update' | 'subscribe'
>;

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
	keys = keychain,
	send = (id) => connectionFetch(id),
}: {
	file: ConnectionsFile;
	keys?: ConnectionKeys;
	send?: (id: string) => Send;
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
				`The connections note could not be read: ${note.error.message}`,
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
				`The connections note could not be saved: ${written.error.message}`,
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
		// No key here: the shell adds the one it keeps for this connection.
		endpoint: (record) =>
			custom({
				id: record.id,
				name: record.name,
				baseUrl: record.baseUrl,
				fetch: send(record.id),
				models: record.models,
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
