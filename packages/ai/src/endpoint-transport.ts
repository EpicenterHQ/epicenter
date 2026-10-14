import { isTauri } from '@tauri-apps/api/core';
import type { AiTransport } from './inference.js';

/** Desktop endpoint requests cross the trusted host, including multipart bodies. */
export function endpointFetch(): AiTransport['fetch'] {
	const send = globalThis.fetch.bind(globalThis);
	if (!isTauri()) return send;
	const endpoint = new URL('/_epicenter/inference', window.location.origin)
		.href;
	return async (input, init) => {
		const request = new Request(input, init);
		const headers = new Headers(request.headers);
		headers.delete('cookie');
		const body = request.body ? await request.blob() : undefined;
		request.signal.throwIfAborted();
		headers.set('x-epicenter-inference-url', request.url);
		return send(endpoint, {
			method: request.method,
			headers,
			body,
			signal: request.signal,
			credentials: 'include',
			redirect: 'error',
		});
	};
}
