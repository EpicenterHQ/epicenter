/**
 * The person's connected endpoints as one live entry of `openAi([...])`:
 * the endpoint each saved connection makes, beside the actions that change
 * them. The list is `connections.md` in this computer's settings
 * (`@epicenter/local`: AppData in a Tauri window, this browser's storage in
 * a browser): each connection's id, name, base URL and models, and the
 * endpoint its key was entered for, never the key. Where a key is kept is
 * `connection-keys.ts`'s: in a Tauri window the shell holds it and sends
 * each request with it (`relayed`); in a browser the page holds it.
 *
 * The page reads the list once the settings connected (`<WhenOpen>`), so
 * `endpoints()` and `list()` are the truth. When `connections.md` does not
 * read, nothing is merged and `problem()` names it; adding a connection
 * replaces it. The actions wait for the connection and run one at a time,
 * each over what the one before it left.
 */
import { settings } from '@epicenter/local';
import { nanoid } from 'nanoid';
import { connectionKeys } from './connection-keys.js';
import type { Endpoint } from './endpoint.js';
import { type SettingError, settingNote } from './setting-note.js';

/** What a person enters for a connection. */
export type CustomConnectionInput = {
	name?: string;
	baseUrl: string;
	apiKey?: string;
	models?: string[];
};

/** A connection as `connections.md` keeps it: `key` is the endpoint its key was entered for, when it has one. */
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

/** `connections.md`: the person's connections, in their order, never a key. */
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
					key: { type: 'string' },
				},
				required: ['id', 'name', 'baseUrl', 'models'],
			},
		},
	},
	required: ['connections'],
} as const;

/** The person's connected endpoints, as `openAi` merges them and a picker changes them. */
export type CustomEndpoints = {
	/** The endpoint each saved connection makes, in the person's order. */
	endpoints(): readonly Endpoint[];
	/** Called when the connections, and so `endpoints()`, may have changed; returns the unsubscribe. */
	subscribe(listener: () => void): () => void;
	/** The saved connections, each saying whether a key applies to it. */
	list(): readonly ConnectionSnapshot[];
	/** Why `connections.md` does not read, or null. While it does not, none is merged. */
	problem(): SettingError | null;
	/**
	 * Whether this computer's shell keeps each key and sends each request,
	 * so any endpoint works; otherwise the page keeps the key and sends from
	 * the tab, so the endpoint must allow this origin (CORS).
	 */
	readonly relayed: boolean;
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

/** The person's connected endpoints on this computer, as one entry of `openAi([...])`. */
export function customEndpoints(): CustomEndpoints {
	const file = settings.file('connections.md');
	const note = settingNote(connectionsCollection, file);
	/** The endpoint each record made, by the record and its key, so one stays the same value while neither changes. */
	let made_: Map<string, Endpoint> = new Map();
	let shownRecords: readonly ConnectionRecord[] | null = null;
	let shownEndpoints: readonly Endpoint[] = [];

	function records(): ConnectionRecord[] {
		const read = note.get();
		return read.error === null ? [...(read.data?.connections ?? [])] : [];
	}

	/** Changes run one at a time, each over what the one before it left. */
	let changing: Promise<unknown> = Promise.resolve();
	function change<T>(step: (current: ConnectionRecord[]) => Promise<T>) {
		const run = changing.then(async () => {
			await file.connected();
			return step(records());
		});
		changing = run.catch(() => {});
		return run;
	}

	const write = (list: ConnectionRecord[]) => note.set({ connections: list });

	const entry: CustomEndpoints = {
		endpoints() {
			const now = note.get().data?.connections ?? [];
			if (now === shownRecords) return shownEndpoints;
			shownRecords = now;
			const kept = new Map<string, Endpoint>();
			shownEndpoints = now.map((record) => {
				const id = `${JSON.stringify(record)}\0${connectionKeys.keyOf(record) ?? ''}`;
				const endpoint = made_.get(id) ?? connectionKeys.endpoint(record);
				kept.set(id, endpoint);
				return endpoint;
			});
			made_ = kept;
			return shownEndpoints;
		},
		subscribe(listener) {
			const stopNote = note.subscribe(listener);
			const stopKeys = connectionKeys.subscribe(() => {
				shownRecords = null;
				listener();
			});
			return () => {
				stopNote();
				stopKeys();
			};
		},
		list: () =>
			records().map(({ key, ...record }) => ({
				...record,
				models: [...record.models],
				hasApiKey: key === record.baseUrl,
			})),
		problem: () => note.get().error,
		relayed: connectionKeys.relayed,
		add({ apiKey, ...input }) {
			return change(async (list) => {
				const record: ConnectionRecord = {
					id: nanoid(),
					name: input.name ?? hostOf(input.baseUrl),
					baseUrl: input.baseUrl,
					models: [...(input.models ?? [])],
				};
				if (apiKey?.trim()) {
					await connectionKeys.set(record.id, record.baseUrl, apiKey);
					record.key = record.baseUrl;
				}
				await write([...list, record]);
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
				// A new key is kept for the endpoint it was entered with; an
				// endpoint changed here keeps the key that applied to it.
				if (apiKey !== undefined) {
					await connectionKeys.set(id, next.baseUrl, apiKey.trim() || null);
					if (apiKey.trim()) next.key = next.baseUrl;
					else delete next.key;
				} else if (
					next.baseUrl !== record.baseUrl &&
					record.key === record.baseUrl
				) {
					await connectionKeys.move(id, record.baseUrl, next.baseUrl);
					next.key = next.baseUrl;
				}
				await write(list.map((other) => (other.id === id ? next : other)));
			});
		},
		remove(id) {
			return change(async (list) => {
				await write(list.filter((other) => other.id !== id));
				await connectionKeys.set(id, '', null);
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
				await write(order.flatMap((id) => byId.get(id) ?? []));
			});
		},
	};
	made.add(entry);
	return entry;
}
