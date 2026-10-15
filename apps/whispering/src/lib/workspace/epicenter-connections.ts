/**
 * Whispering's two connections, kept in Epicenter's AI connections.
 *
 * Inside Epicenter, a connection is an entry in the catalog Epicenter's host
 * keeps for every app on this computer (`/_epicenter/ai/no-account/`): its
 * base URL and models in Epicenter's application data, its key in the system
 * keychain. The window is told whether a key is set, never the key. A request
 * goes through the host, which adds the key and forwards it to the entry's
 * own base URL, so the endpoint needs no CORS headers and the key never
 * reaches the page.
 *
 * Whispering names the two entries it uses, one per operation, by their
 * catalog ids, remembered in this origin's `localStorage`. An entry removed
 * elsewhere reads as not set up; the next save creates another.
 *
 * The rules are `connections.ts`'s: a canonical base URL, a model, and a key
 * kept only for the base URL it was saved for. A request names the base URL it
 * was prepared for and is sent only while the entry still targets it.
 */
import { Err, Ok, type Result } from 'wellcrafted/result';
import {
	applyConnectionChange,
	type ConnectionChange,
	type ConnectionInfo,
	type ConnectionsInfo,
	OPERATION_NAMES,
	type Operation,
	type StoredConnection,
} from '../connections.js';

/** One catalog entry as the host reports it. Never a key. */
export type CatalogEntry = {
	readonly id: string;
	readonly name: string;
	readonly baseUrl: string;
	readonly models: readonly string[];
	readonly hasApiKey: boolean;
	/** Changes whenever the entry's base URL or key changes. */
	readonly accessVersion: string;
};

/** Where Whispering remembers which catalog entry each operation uses. */
const CATALOG_IDS_STORAGE = 'whispering.epicenterConnections';

const ENTRY_NAMES: Record<Operation, string> = {
	transcription: 'Whispering transcription',
	text: 'Whispering text',
};

/** Stands in for a key the host holds, so `applyConnectionChange` can refuse carrying it elsewhere. */
const HELD_KEY = 'held by Epicenter';

const describe = (cause: unknown) =>
	cause instanceof Error ? cause.message : String(cause);

function entryOf(value: unknown): CatalogEntry {
	if (typeof value !== 'object' || value === null)
		throw new Error(
			'Epicenter answered with an AI connection that does not read.',
		);
	const entry = value as Record<string, unknown>;
	if (
		typeof entry.id !== 'string' ||
		typeof entry.name !== 'string' ||
		typeof entry.baseUrl !== 'string' ||
		!Array.isArray(entry.models) ||
		entry.models.some((model) => typeof model !== 'string') ||
		typeof entry.hasApiKey !== 'boolean' ||
		typeof entry.accessVersion !== 'string' ||
		'apiKey' in entry
	)
		throw new Error(
			'Epicenter answered with an AI connection that does not read.',
		);
	return {
		id: entry.id,
		name: entry.name,
		baseUrl: entry.baseUrl,
		models: entry.models as string[],
		hasApiKey: entry.hasApiKey,
		accessVersion: entry.accessVersion,
	};
}

function snapshotOf(value: unknown): CatalogEntry[] {
	if (
		typeof value !== 'object' ||
		value === null ||
		!Array.isArray((value as { connections?: unknown }).connections)
	)
		throw new Error('Epicenter answered with AI connections that do not read.');
	return (value as { connections: unknown[] }).connections.map(entryOf);
}

/** The catalog ids Whispering uses. Storage that does not read is reported, never taken for none. */
function rememberedIds(): Partial<Record<Operation, string>> {
	const text = localStorage.getItem(CATALOG_IDS_STORAGE);
	if (text === null) return {};
	let parsed: unknown;
	try {
		parsed = JSON.parse(text);
	} catch {
		parsed = undefined;
	}
	if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed))
		throw new Error(
			`Whispering’s note of which Epicenter connections it uses, ${CATALOG_IDS_STORAGE} in this site’s storage, does not read. Remove it and set the connections up again in Settings.`,
		);
	const ids: Partial<Record<Operation, string>> = {};
	for (const operation of ['transcription', 'text'] as const) {
		const id = (parsed as Record<string, unknown>)[operation];
		if (typeof id === 'string') ids[operation] = id;
	}
	return ids;
}

export type EpicenterConnections = ReturnType<
	typeof createEpicenterConnections
>;

/** A same-origin `fetch`. */
export type Send = (input: string, init?: RequestInit) => Promise<Response>;

/**
 * The catalog of the Epicenter host serving this page, at `origin`. Every
 * request is same-origin and carries the window's session cookie; `send` is
 * `fetch`, injected for tests.
 */
export function createEpicenterConnections({
	origin,
	send,
}: {
	origin: string;
	send: Send;
}) {
	const catalog = new URL('/_epicenter/ai/no-account/', origin).href;

	async function entries(): Promise<CatalogEntry[]> {
		const response = await send(`${catalog}connections`, {
			credentials: 'same-origin',
			redirect: 'error',
		});
		if (!response.ok)
			throw new Error(
				`Epicenter did not list its AI connections (${response.status}).`,
			);
		return snapshotOf(await response.json());
	}

	async function execute(command: object): Promise<unknown> {
		const response = await send(`${catalog}connections`, {
			method: 'POST',
			credentials: 'same-origin',
			redirect: 'error',
			headers: { 'content-type': 'application/json' },
			body: JSON.stringify(command),
		});
		if (!response.ok)
			throw new Error(
				`Epicenter did not save the AI connection (${response.status}).`,
			);
		return ((await response.json()) as { result?: unknown }).result;
	}

	/** The entry `operation` uses now, or undefined when none is set up. */
	async function entry(
		operation: Operation,
	): Promise<CatalogEntry | undefined> {
		const id = rememberedIds()[operation];
		if (id === undefined) return undefined;
		return (await entries()).find((entry) => entry.id === id);
	}

	function infoOf(entry: CatalogEntry | undefined): ConnectionInfo | undefined {
		return (
			entry && {
				baseUrl: entry.baseUrl,
				model: entry.models[0] ?? '',
				keyPresent: entry.hasApiKey,
				readOnlyReason: undefined,
			}
		);
	}

	async function read(): Promise<ConnectionsInfo> {
		const ids = rememberedIds();
		const listed = Object.keys(ids).length === 0 ? [] : await entries();
		const find = (operation: Operation) =>
			listed.find((entry) => entry.id === ids[operation]);
		return {
			transcription: infoOf(find('transcription')),
			text: infoOf(find('text')),
			legacyKey: false,
		};
	}

	return {
		read,
		entry,

		/** Save one connection: its entry is changed in place, or made. */
		async set(
			operation: Operation,
			change: ConnectionChange,
		): Promise<Result<ConnectionsInfo, string>> {
			try {
				const ids = rememberedIds();
				const current = await entry(operation);
				const { data: next, error: changeError } = applyConnectionChange(
					operation,
					current && {
						baseUrl: current.baseUrl,
						model: current.models[0] ?? '',
						...(current.hasApiKey && { apiKey: HELD_KEY }),
					},
					change,
				);
				if (changeError !== null) return Err(changeError);
				// A kept key is never sent: the host keeps it with the entry.
				const key =
					change.key.action === 'replace'
						? { apiKey: next.apiKey }
						: change.key.action === 'remove'
							? { apiKey: '' }
							: {};
				if (current === undefined) {
					const id = await execute({
						type: 'add',
						input: {
							name: ENTRY_NAMES[operation],
							baseUrl: next.baseUrl,
							models: [next.model],
							...key,
						},
					});
					if (typeof id !== 'string')
						return Err('Epicenter did not say which AI connection it made.');
					localStorage.setItem(
						CATALOG_IDS_STORAGE,
						JSON.stringify({ ...ids, [operation]: id }),
					);
				} else
					await execute({
						type: 'update',
						id: current.id,
						patch: { baseUrl: next.baseUrl, models: [next.model], ...key },
					});
				return Ok(await read());
			} catch (cause) {
				return Err(describe(cause));
			}
		},

		/**
		 * The stored connection a request is checked against, and the `fetch`
		 * that sends it through the host to that same entry. The entry is read
		 * once; a change saved while the request is out makes the host refuse
		 * it rather than retarget it.
		 */
		async route(operation: Operation): Promise<
			| {
					readonly stored: StoredConnection;
					readonly send: (url: string, init?: RequestInit) => Promise<Response>;
			  }
			| undefined
		> {
			const found = await entry(operation);
			if (found === undefined) return undefined;
			const base = found.baseUrl.replace(/\/+$/, '');
			return {
				stored: { baseUrl: found.baseUrl, model: found.models[0] ?? '' },
				send(url, init) {
					if (!url.startsWith(`${base}/`))
						throw new Error(
							`${url} is not below the ${OPERATION_NAMES[operation]} connection's base URL.`,
						);
					const inference = `${catalog}inference/${encodeURIComponent(found.id)}/${encodeURIComponent(found.accessVersion)}/${url.slice(base.length + 1)}`;
					// The window's session cookie admits it to the host; the host
					// adds the key and sends no cookie on.
					return send(inference, { ...init, credentials: 'same-origin' });
				},
			};
		},
	};
}
