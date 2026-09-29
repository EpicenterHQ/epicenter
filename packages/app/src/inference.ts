import type { AuthFetch } from '@epicenter/auth';
import OpenAI from 'openai';

export type AiTransport = { baseURL: string; fetch: AuthFetch };

import type { EndpointInferenceOptions } from './ai.js';

export function validateInferenceDestination(value: string) {
	const url = new URL(value);
	if (
		!['http:', 'https:'].includes(url.protocol) ||
		url.username ||
		url.password ||
		url.search ||
		url.hash
	)
		throw new Error('Invalid inference destination.');
	return url.href.replace(/\/+$/, '');
}

/** One destination owns credential resolution, requests, and response bodies. */
export function createInference(
	transport: AiTransport,
	getAuthHeaders?: EndpointInferenceOptions['getAuthHeaders'],
) {
	const lifetime = new AbortController();
	const pending = new Set<Promise<void>>();
	const cleanupFailures: unknown[] = [];
	let closing: Promise<void> | undefined;
	function assertUsable() {
		lifetime.signal.throwIfAborted();
	}
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

	const baseURL = validateInferenceDestination(transport.baseURL);
	const fetch = transport.fetch;
	const client = new OpenAI({
		baseURL,
		apiKey: 'transport-owned',
		adminAPIKey: null,
		organization: null,
		project: null,
		dangerouslyAllowBrowser: true,
		maxRetries: 0,
		fetch: async (input, init) => {
			assertUsable();
			const url = new URL(input instanceof Request ? input.url : input);
			if (!url.href.startsWith(`${baseURL}/`))
				throw new Error('The client cannot change its inference destination.');
			const caller =
				init?.signal ?? (input instanceof Request ? input.signal : undefined);
			const signal = AbortSignal.any([
				lifetime.signal,
				...(caller ? [caller] : []),
			]);
			signal.throwIfAborted();
			const completion = Promise.withResolvers<void>();
			pending.add(completion.promise);
			const finish = () => {
				pending.delete(completion.promise);
				completion.resolve();
			};
			try {
				const headers = new Headers(
					input instanceof Request ? input.headers : undefined,
				);
				new Headers(init?.headers).forEach((value, name) =>
					headers.set(name, value),
				);
				headers.delete('authorization');
				headers.delete('cookie');
				const authentication = new Headers(await getAuthHeaders?.({ signal }));
				authentication.forEach((value, name) => headers.set(name, value));
				headers.delete('cookie');
				signal.throwIfAborted();
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
					// Cancellation must settle before inference close can finish.
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
	return Object.freeze({
		client,
		signal: lifetime.signal,
		close(): Promise<void> {
			if (closing) return closing;
			const completion = Promise.withResolvers<void>();
			closing = completion.promise;
			lifetime.abort(new Error('Inference access is closed.'));
			void (async () => {
				await Promise.allSettled(pending);
				if (cleanupFailures.length)
					throw new AggregateError(
						cleanupFailures,
						'Inference cleanup failed.',
					);
			})().then(completion.resolve, completion.reject);
			return closing;
		},
	});
}
export type Inference = ReturnType<typeof createInference>;
