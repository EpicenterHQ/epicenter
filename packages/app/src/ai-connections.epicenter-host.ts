import { type AccountIdentity, deviceOwnerPath } from '@epicenter/principal';
import { createLogger } from 'wellcrafted/logger';
import { type AiTransport, accountInference } from './ai.js';
import type {
	AiConnectionSnapshot,
	AiConnections,
	CustomConnectionInput,
} from './ai-connections.js';
import type { AppAiBinding } from './index.js';
import { createNativeInferenceTransport } from './native-ai.js';

const log = createLogger('desktop-ai-connections');

type Snapshot = { revision: number; connections: AiConnectionSnapshot[] };

function snapshot(value: unknown): Snapshot {
	if (!value || typeof value !== 'object')
		throw new Error('Invalid desktop AI catalog.');
	const record = value as Record<string, unknown>;
	if (
		!Number.isSafeInteger(record.revision) ||
		(record.revision as number) < 0 ||
		!Array.isArray(record.connections)
	)
		throw new Error('Invalid desktop AI catalog.');
	const connections = record.connections.map((value: unknown) => {
		if (!value || typeof value !== 'object')
			throw new Error('Invalid desktop AI connection.');
		const entry = value as Record<string, unknown>;
		if (
			typeof entry.id !== 'string' ||
			!entry.id ||
			typeof entry.name !== 'string' ||
			typeof entry.baseUrl !== 'string' ||
			typeof entry.hasApiKey !== 'boolean' ||
			typeof entry.accessVersion !== 'string' ||
			!entry.accessVersion ||
			!Array.isArray(entry.models) ||
			entry.models.some((model) => typeof model !== 'string') ||
			'apiKey' in entry
		)
			throw new Error('Invalid desktop AI connection.');
		return {
			id: entry.id,
			name: entry.name,
			baseUrl: entry.baseUrl,
			models: entry.models as string[],
			hasApiKey: entry.hasApiKey,
			accessVersion: entry.accessVersion,
		};
	});
	if (new Set(connections.map((entry) => entry.id)).size !== connections.length)
		throw new Error('Invalid desktop AI catalog.');
	return { revision: record.revision as number, connections };
}

/** One App's subscribed view of the desktop profile's durable catalog. */
export function createDesktopAiConnections({
	account,
	baseURL = window.location.origin,
	fetch = globalThis.fetch.bind(globalThis),
	openEvents = (url: string) => new EventSource(url, { withCredentials: true }),
}: {
	account?: AccountIdentity;
	baseURL?: string;
	fetch?: AiTransport['fetch'];
	openEvents?: (
		url: string,
	) => Pick<EventSource, 'onmessage' | 'onerror' | 'close'>;
}): AiConnections {
	const owner = deviceOwnerPath(account).replaceAll('/', '_');
	const endpoint = new URL(`/_epicenter/ai/${owner}/`, baseURL).href;
	const controller = new AbortController();
	const pending = new Set<Promise<unknown>>();
	const initial = Promise.withResolvers<void>();
	void initial.promise.catch(() => {});
	let events: ReturnType<typeof openEvents> | undefined;
	let current: Snapshot = { revision: -1, connections: [] };
	const listeners = new Set<
		(records: readonly AiConnectionSnapshot[]) => void
	>();
	function assertOpen() {
		controller.signal.throwIfAborted();
	}
	function apply(value: unknown) {
		assertOpen();
		const next = snapshot(value);
		if (next.revision <= current.revision) return;
		current = next;
		for (const listener of listeners) {
			try {
				listener(structuredClone(current.connections));
			} catch (cause) {
				log.error(new Error('AI connection subscriber failed.', { cause }));
			}
		}
	}
	function execute(command: object) {
		assertOpen();
		const operation = (async () => {
			const response = await fetch(`${endpoint}connections`, {
				method: 'POST',
				credentials: 'include',
				redirect: 'error',
				signal: controller.signal,
				headers: { 'content-type': 'application/json' },
				body: JSON.stringify(command),
			});
			if (!response.ok) {
				await response.body?.cancel();
				throw new Error('Could not save the desktop AI catalog.');
			}
			const result = (await response.json()) as {
				snapshot: unknown;
				result?: unknown;
			};
			apply(result.snapshot);
			return result.result;
		})();
		pending.add(operation);
		void operation.then(
			() => pending.delete(operation),
			() => pending.delete(operation),
		);
		return operation;
	}
	const ready = (async () => {
		assertOpen();
		events = openEvents(`${endpoint}events`);
		events.onmessage = (event) => {
			try {
				apply(JSON.parse(event.data));
				initial.resolve();
			} catch (cause) {
				initial.reject(cause);
				controller.abort(new Error('Desktop AI catalog observation failed.'));
				events?.close();
			}
		};
		events.onerror = () =>
			initial.reject(new Error('Could not open the desktop AI catalog.'));
		await initial.promise;
	})();
	void ready.catch(() => {
		controller.abort(new Error('Desktop AI catalog opening failed.'));
		events?.close();
	});
	return {
		ready,
		getAll() {
			assertOpen();
			return structuredClone(current.connections);
		},
		subscribe(listener) {
			assertOpen();
			listeners.add(listener);
			try {
				listener(structuredClone(current.connections));
			} catch (cause) {
				listeners.delete(listener);
				throw cause;
			}
			return () => {
				listeners.delete(listener);
			};
		},
		async add(input: CustomConnectionInput) {
			const id = await execute({ type: 'add', input });
			if (typeof id !== 'string')
				throw new Error('Invalid desktop AI connection ID.');
			return id;
		},
		async update(id, patch) {
			await execute({ type: 'update', id, patch });
		},
		async remove(id) {
			await execute({ type: 'remove', id });
		},
		async reorder(ids) {
			await execute({ type: 'reorder', ids });
		},
		transport(record) {
			const base = record.baseUrl.replace(/\/+$/, '');
			const path = `${endpoint}inference/${encodeURIComponent(record.id)}/${encodeURIComponent(record.accessVersion!)}/`;
			return {
				baseURL: base,
				async fetch(input, init) {
					assertOpen();
					const request = new Request(input, init);
					if (!request.url.startsWith(`${base}/`))
						throw new Error('Invalid inference destination.');
					const headers = new Headers(request.headers);
					headers.delete('authorization');
					headers.delete('cookie');
					const signal = AbortSignal.any([controller.signal, request.signal]);
					// Passing Request as RequestInit turns even FormData into a stream
					// upload, which WebKit rejects. Keep its encoded bytes and boundary.
					const body = request.body ? await request.blob() : undefined;
					signal.throwIfAborted();
					return fetch(`${path}${request.url.slice(base.length + 1)}`, {
						method: request.method,
						headers,
						body,
						cache: request.cache,
						integrity: request.integrity,
						keepalive: request.keepalive,
						mode: request.mode,
						referrer: request.referrer,
						referrerPolicy: request.referrerPolicy,
						credentials: 'include',
						redirect: 'error',
						signal,
					});
				},
			};
		},
		previewTransport(input) {
			const base = input.baseUrl.replace(/\/+$/, '');
			return {
				baseURL: base,
				fetch(requestInput, init) {
					assertOpen();
					const request = new Request(requestInput, init);
					if (request.url !== `${base}/models` || request.method !== 'GET')
						throw new Error(
							'Connection preview supports model discovery only.',
						);
					return fetch(`${endpoint}preview`, {
						method: 'POST',
						credentials: 'include',
						redirect: 'error',
						headers: { 'content-type': 'application/json' },
						body: JSON.stringify(input),
						signal: AbortSignal.any([controller.signal, request.signal]),
					});
				},
			};
		},
		async close() {
			controller.abort(new Error('App AI connections are closed.'));
			events?.close();
			listeners.clear();
			initial.reject(controller.signal.reason);
			await Promise.allSettled([ready, ...pending]);
		},
	};
}

/** Same collection API; its persistence and credentials belong to the desktop host, and native file inference is the runtime transport. */
export function createEpicenterHostAppAi(): AppAiBinding {
	return {
		account: accountInference,
		runtime: createNativeInferenceTransport(),
		connections: (_appId, account) => createDesktopAiConnections({ account }),
	};
}

/** Default desktop composition selected by the package build condition. */
export const createDefaultAppAi: () => AppAiBinding = createEpicenterHostAppAi;
