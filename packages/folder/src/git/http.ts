/**
 * Browser Git's HTTP: requests over `fetch` that honor an abort signal, so
 * closing the folder stops an in-flight push or fetch.
 */

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

/** One request of a Git transfer. */
export type HttpRequest = (
	url: string,
	init?: {
		readonly method?: 'GET' | 'POST';
		readonly headers?: Record<string, string>;
		readonly body?: Uint8Array;
	},
) => Promise<Response>;

/** Git requests through `httpFetch` that stop when `signal` aborts. */
export function abortableHttp(
	signal: AbortSignal,
	httpFetch: HttpFetch = globalThis.fetch,
): HttpRequest {
	return (url, { method = 'GET', headers = {}, body } = {}) => {
		const authorized = Object.keys(headers).some(
			(name) => name.toLowerCase() === 'authorization',
		);
		return httpFetch(url, {
			method,
			headers,
			body: body as Uint8Array<ArrayBuffer> | undefined,
			signal,
			// Git needs no cookie, and a credential goes to the URL it was
			// given for, never wherever a redirect points.
			credentials: 'omit',
			redirect: authorized ? 'error' : 'follow',
		});
	};
}
