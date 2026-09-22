import type { Account } from '@epicenter/auth';
import { isTauri } from '@tauri-apps/api/core';
import { createInference, type Inference } from './inference.js';
import type {
	AiConnectionSnapshot,
	AiConnections,
	CustomConnectionInput,
} from './ai-connections.js';
import { createBrowserConnections } from './browser.js';
import { createDesktopAiConnections } from './ai-connections.epicenter-host.js';

/** Saved access owns cached clients and their retirement, independently of data stores. */
export async function openConnectionCatalog(connections: AiConnections) {
	const lifetime = new AbortController();
	const retired = new Set<Promise<void>>();
	const failures: unknown[] = [];
	const clients = new Map<
		string,
		Inference & { baseUrl: string; apiKey?: string; accessVersion?: string }
	>();
	let closing: Promise<void> | undefined;
	function assertUsable() {
		lifetime.signal.throwIfAborted();
	}
	function retire(client: Inference) {
		const closing = client.close();
		retired.add(closing);
		void closing.then(
			() => retired.delete(closing),
			(cause) => {
				retired.delete(closing);
				failures.push(cause);
			},
		);
	}

	function invalidate() {
		const current = connections.getAll();
		for (const [id, cached] of clients) {
			const record = current.find((entry) => entry.id === id);
			if (
				!record ||
				record.baseUrl !== cached.baseUrl ||
				record.apiKey !== cached.apiKey ||
				record.accessVersion !== cached.accessVersion
			) {
				retire(cached);
				clients.delete(id);
			}
		}
	}
	let unsubscribe: (() => void) | undefined;
	try {
		await connections.ready;
		connections.signal.throwIfAborted();
		unsubscribe = connections.subscribe(invalidate);
	} catch (cause) {
		try {
			await connections.close();
		} catch (cleanup) {
			throw new AggregateError(
				[cause, cleanup],
				'Catalog opening and cleanup failed.',
				{ cause },
			);
		}
		throw cause;
	}
	function entry(record: AiConnectionSnapshot) {
		let cached = clients.get(record.id);
		if (!cached) {
			cached = {
				baseUrl: record.baseUrl,
				apiKey: record.apiKey,
				accessVersion: record.accessVersion,
				...createInference(
					connections.transport(record),
					record.apiKey
						? () => ({ Authorization: `Bearer ${record.apiKey!.trim()}` })
						: undefined,
				),
			};
			clients.set(record.id, cached);
		}
		return Object.freeze({
			...record,
			hasApiKey: record.hasApiKey ?? Boolean(record.apiKey?.trim()),
			models: Object.freeze(record.models),
			client: cached.client,
		});
	}
	function close(): Promise<void> {
		if (closing) return closing;
		const completion = Promise.withResolvers<void>();
		closing = completion.promise;
		unsubscribe?.();
		connections.signal.removeEventListener('abort', retiredBackend);
		for (const cached of clients.values()) retire(cached);
		clients.clear();
		lifetime.abort();
		void (async () => {
			try {
				await connections.close();
			} catch (cause) {
				failures.push(cause);
			}
			await Promise.allSettled(retired);
			if (failures.length)
				throw new AggregateError(failures, 'Catalog cleanup failed.');
		})().then(completion.resolve, completion.reject);
		return closing;
	}
	const retiredBackend = () => {
		void close().catch(() => {});
	};
	connections.signal.addEventListener('abort', retiredBackend, { once: true });
	if (connections.signal.aborted) {
		await close();
		throw connections.signal.reason;
	}

	return Object.freeze({
		getAll() {
			assertUsable();
			return Object.freeze(connections.getAll().map(entry));
		},
		get(id: string) {
			assertUsable();
			const record = connections.getAll().find((record) => record.id === id);
			return record ? entry(record) : null;
		},
		add(input: CustomConnectionInput) {
			assertUsable();
			return connections.add(input);
		},
		update(id: string, patch: Partial<CustomConnectionInput>) {
			assertUsable();
			return connections.update(id, patch);
		},
		remove(id: string) {
			assertUsable();
			return connections.remove(id);
		},
		reorder(ids: readonly string[]) {
			assertUsable();
			return connections.reorder(ids);
		},
		subscribe(
			listener: (records: readonly ReturnType<typeof entry>[]) => void,
		) {
			assertUsable();
			return connections.subscribe((records) =>
				listener(Object.freeze(records.map(entry))),
			);
		},
		signal: lifetime.signal,
		close,
	});
}
export type ConnectionCatalog = Awaited<
	ReturnType<typeof openConnectionCatalog>
>;

export async function openLocalConnectionCatalog() {
	return openConnectionCatalog(
		isTauri() ? createDesktopAiConnections({}) : createBrowserConnections(),
	);
}
export async function openAccountConnectionCatalog({
	account,
}: {
	account: Account;
}) {
	const identity = Object.freeze({
		authorityId: account.authorityId,
		principalId: account.principalId,
	});
	return openConnectionCatalog(
		isTauri()
			? createDesktopAiConnections({ account: identity })
			: createBrowserConnections(identity),
	);
}
