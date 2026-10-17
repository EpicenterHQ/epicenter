/**
 * An isomorphic-git HTTP client over `fetch` that honors an abort signal.
 *
 * The bundled web client ignores cancellation. Passing the owner's signal to
 * `fetch` lets closing the folder stop an in-flight push or fetch transport.
 */
import type { GitHttpRequest, HttpClient } from 'isomorphic-git';

/** HTTP capability used for this folder's Git requests. */
export type HttpFetch = (
	input: Request | string | URL,
	init?: RequestInit,
) => Promise<Response>;

/** A username and password for one remote. A token is the password. */
export type GitCredential = {
	readonly username: string;
	readonly password: string;
};

/**
 * Asked right before each push and fetch, with the exact URL Git is about to
 * reach. `undefined` sends no credential; a throw refuses the transfer. The
 * folder keeps nothing it returns: not in `origin`, its files, or its Git
 * configuration.
 */
export type GitCredentials = (
	url: string,
	signal: AbortSignal,
) => Promise<GitCredential | undefined>;

/** The `Authorization` value for `credential`: HTTP Basic, UTF-8. */
export function basicAuthorization({ username, password }: GitCredential) {
	const bytes = new TextEncoder().encode(`${username}:${password}`);
	let binary = '';
	for (const byte of bytes) binary += String.fromCharCode(byte);
	return `Basic ${btoa(binary)}`;
}

async function collect(
	body: GitHttpRequest['body'],
): Promise<Uint8Array | undefined> {
	if (body === undefined) return undefined;
	const chunks: Uint8Array[] = [];
	let size = 0;
	for await (const chunk of body) {
		chunks.push(chunk);
		size += chunk.byteLength;
	}
	const bytes = new Uint8Array(size);
	let offset = 0;
	for (const chunk of chunks) {
		bytes.set(chunk, offset);
		offset += chunk.byteLength;
	}
	return bytes;
}

async function* chunks(stream: ReadableStream<Uint8Array>) {
	const reader = stream.getReader();
	try {
		while (true) {
			const { done, value } = await reader.read();
			if (done) return;
			yield value;
		}
	} finally {
		reader.releaseLock();
	}
}

export function abortableHttp(
	signal: AbortSignal,
	httpFetch: HttpFetch = globalThis.fetch,
): HttpClient {
	return {
		async request({ url, method = 'GET', headers = {}, body }) {
			const payload = await collect(body);
			const authorized = Object.keys(headers).some(
				(name) => name.toLowerCase() === 'authorization',
			);
			const response = await httpFetch(url, {
				method,
				headers,
				body: payload as Uint8Array<ArrayBuffer> | undefined,
				signal,
				// Git needs no cookie, and a credential goes to the URL it was
				// given for, never wherever a redirect points.
				credentials: 'omit',
				redirect: authorized ? 'error' : 'follow',
			});
			return {
				url: response.url,
				method,
				statusCode: response.status,
				statusMessage: response.statusText,
				headers: Object.fromEntries(response.headers),
				body: response.body ? chunks(response.body) : (async function* () {})(),
			};
		},
	};
}
