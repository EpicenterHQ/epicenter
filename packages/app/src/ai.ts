import type { Account, AuthFetch } from '@epicenter/auth';
import type { AccountIdentity } from '@epicenter/principal';
import OpenAI from 'openai';
import type {
	AiConnectionSnapshot,
	AiConnections,
	CustomConnectionInput,
} from './ai-connections.js';

export type AiTransport = { baseURL: string; fetch: AuthFetch };
export type AppAi = ReturnType<typeof createAppAi>['value']['ai'];

/** The App supplies the admission gate; this owner drains HTTP bodies, not just headers. */
export function createAppAi({
	lifetime,
	account,
	runtime,
	connections,
	configuredFetch = async () => {
		throw new Error('No configured inference transport is available.');
	},
}: {
	lifetime: { assertUsable(): void; signal: AbortSignal };
	account: (AiTransport & { identity: AccountIdentity }) | null;
	runtime: AiTransport | null;
	connections: AiConnections | null;
	configuredFetch?: AuthFetch;
}) {
	let hydrated = connections?.ready === undefined;
	const ready = Promise.resolve(connections?.ready).then(() => {
		hydrated = true;
	});
	// openApp consumes this failure; construction must not leave an unhandled rejection.
	void ready.catch(() => {});
	function assertUsable() {
		lifetime.assertUsable();
		if (!hydrated) throw new Error('AI connections are not ready.');
	}
	const pending = new Set<Promise<void>>();
	const cleanupFailures: unknown[] = [];
	const clients = new Map<
		string,
		{
			baseUrl: string;
			apiKey?: string;
			accessVersion?: string;
			client: OpenAI;
			retire(): void;
		}
	>();

	async function cancelBody(
		reader: ReadableStreamDefaultReader<Uint8Array>,
		reason?: unknown,
	) {
		try {
			await reader.cancel(reason);
		} catch (cause) {
			// Fetch abort can error the stream before this cancellation runs. Cancel
			// then repeats its stored error; an underlying cancel failure instead
			// leaves reader.closed fulfilled because cancellation closes first.
			const alreadyErrored = await reader.closed.then(
				() => false,
				(storedError) => Object.is(storedError, cause),
			);
			if (alreadyErrored) return;
			cleanupFailures.push(cause);
			throw cause;
		}
	}

	function bind(
		{ baseURL: suppliedBaseURL, fetch }: AiTransport,
		apiKey?: string,
	) {
		const retired = new AbortController();
		const baseURL = suppliedBaseURL.replace(/\/+$/, '');
		const client = new OpenAI({
			baseURL,
			apiKey: 'transport-owned',
			dangerouslyAllowBrowser: true,
			maxRetries: 0,
			fetch: async (input, init) => {
				assertUsable();
				retired.signal.throwIfAborted();
				const url = new URL(input instanceof Request ? input.url : input);
				if (!url.href.startsWith(`${baseURL}/`))
					throw new Error(
						'The client cannot change its inference destination.',
					);
				const caller =
					init?.signal ?? (input instanceof Request ? input.signal : undefined);
				const signal = AbortSignal.any([
					lifetime.signal,
					retired.signal,
					...(caller ? [caller] : []),
				]);
				signal.throwIfAborted();
				const completion = Promise.withResolvers<void>();
				pending.add(completion.promise);
				const finish = () => {
					pending.delete(completion.promise);
					completion.resolve();
				};
				const headers = new Headers(
					input instanceof Request ? input.headers : undefined,
				);
				new Headers(init?.headers).forEach((value, name) =>
					headers.set(name, value),
				);
				headers.delete('authorization');
				if (apiKey?.trim())
					headers.set('authorization', `Bearer ${apiKey.trim()}`);
				try {
					const response = await fetch(input, {
						...init,
						headers,
						signal,
						credentials: 'omit',
						redirect: 'error',
					});
					if (signal.aborted) {
						if (response.body) await cancelBody(response.body.getReader());
						signal.throwIfAborted();
					}
					if (!response.body) {
						finish();
						return response;
					}
					const reader = response.body.getReader();
					let controller: ReadableStreamDefaultController<Uint8Array>;
					let ended = false;
					const done = () => {
						ended = true;
						signal.removeEventListener('abort', abort);
						finish();
					};
					const abort = () => {
						if (ended) return;
						ended = true;
						controller.error(
							caller?.aborted
								? caller.reason
								: new Error('Inference access was retired.'),
						);
						// Cancellation must settle before App close can release the App.
						void cancelBody(reader, signal.reason).then(done, done);
					};
					const body = new ReadableStream<Uint8Array>(
						{
							start(value) {
								controller = value;
								signal.addEventListener('abort', abort, { once: true });
								if (signal.aborted) abort();
							},
							async pull(value) {
								try {
									const chunk = await reader.read();
									if (ended) return;
									signal.throwIfAborted();
									if (chunk.done) {
										value.close();
										done();
									} else value.enqueue(chunk.value);
								} catch (cause) {
									if (!ended) {
										value.error(
											caller?.aborted
												? cause
												: new Error('Inference response failed.', { cause }),
										);
										done();
									}
								}
							},
							async cancel(reason) {
								if (ended) return;
								ended = true;
								try {
									await cancelBody(reader, reason);
								} finally {
									done();
								}
							},
						},
						{ highWaterMark: 0 },
					);
					return new Response(body, {
						status: response.status,
						statusText: response.statusText,
						headers: response.headers,
					});
				} catch (cause) {
					finish();
					throw cause;
				}
			},
		});
		return {
			client,
			retire: () => retired.abort(new Error('AI connection was retired.')),
		};
	}

	function invalidate() {
		const current = connections?.getAll() ?? [];
		for (const [id, cached] of clients) {
			const record = current.find((entry) => entry.id === id);
			if (
				!record ||
				record.baseUrl !== cached.baseUrl ||
				record.apiKey !== cached.apiKey ||
				record.accessVersion !== cached.accessVersion
			) {
				cached.retire();
				clients.delete(id);
			}
		}
	}
	const unsubscribe = connections?.subscribe(invalidate);
	function entry(record: AiConnectionSnapshot) {
		let cached = clients.get(record.id);
		if (!cached) {
			cached = {
				baseUrl: record.baseUrl,
				apiKey: record.apiKey,
				accessVersion: record.accessVersion,
				...bind(
					connections?.transport?.(record) ?? {
						baseURL: record.baseUrl,
						fetch: configuredFetch,
					},
					record.apiKey,
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
	const ai = Object.freeze({
		runtime: runtime ? Object.freeze({ client: bind(runtime).client }) : null,
		/** Bound to one account; carries its identity so consumers never reach back into the App. */
		account: account
			? Object.freeze({
					identity: account.identity,
					client: bind(account).client,
				})
			: null,
		/** Device-local custom access. Saved fields include credentials; never sync or log entries. */
		connections: connections
			? Object.freeze({
					getAll() {
						assertUsable();
						return Object.freeze(connections.getAll().map(entry));
					},
					get(id: string) {
						assertUsable();
						const record = connections
							.getAll()
							.find((record) => record.id === id);
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
					/** Inspect a candidate without persisting it; access ends with this App. */
					preview({ baseUrl, apiKey }: { baseUrl: string; apiKey?: string }) {
						assertUsable();
						return bind(
							connections.previewTransport?.({ baseUrl, apiKey }) ?? {
								baseURL: baseUrl,
								fetch: configuredFetch,
							},
							connections.previewTransport ? undefined : apiKey,
						).client;
					},
				})
			: null,
	});
	return {
		value: { ai },
		ready,
		async close() {
			unsubscribe?.();
			try {
				await connections?.close();
			} catch (cause) {
				cleanupFailures.push(cause);
			}
			await Promise.allSettled(pending);
			if (cleanupFailures.length)
				throw new AggregateError(
					cleanupFailures,
					'AI transport cleanup failed.',
				);
			clients.clear();
		},
	};
}

/** Shipped Epicenter server profiles mount /v1 even when provider credentials are absent. */
export function accountInference(account: Account): AiTransport {
	return {
		baseURL: `${account.baseURL.replace(/\/+$/, '')}/v1`,
		fetch: account.fetch,
	};
}
