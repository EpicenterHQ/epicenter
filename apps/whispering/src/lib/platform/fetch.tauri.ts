/**
 * `fetch` through the desktop shell (`send_request` in
 * `src-tauri/src/http.rs`): the request leaves from Rust, not the page, so
 * no endpoint needs to allow the window's `tauri://` origin (CORS). Every
 * transcription and AI request of the desktop build goes this way.
 *
 * The page still makes the whole request: the body (a `FormData` of audio,
 * or JSON) is serialized here, exactly as `fetch` would send it, and travels
 * as the IPC request's raw bytes; the URL, method and headers travel in one
 * header. The answer is the whole response, read before this resolves.
 */
import { invoke } from '@tauri-apps/api/core';

/** The shell's answer, as `send_request` returns it. */
type Answer = {
	status: number;
	statusText: string;
	headers: [string, string][];
	/** Base64. */
	body: string;
};

const fromBase64 = (text: string) =>
	Uint8Array.from(atob(text), (character) => character.charCodeAt(0));

/** What `send` was given, as one plain request. */
async function describe(
	input: string | URL | Request,
	init: RequestInit | undefined,
) {
	// A Request serializes any body type the way fetch would, multipart
	// boundaries included.
	const request = new Request(input, init);
	const headers: [string, string][] = [];
	request.headers.forEach((value, name) => {
		headers.push([name, value]);
	});
	const body =
		request.method === 'GET' || request.method === 'HEAD'
			? new Uint8Array()
			: new Uint8Array(await request.arrayBuffer());
	return {
		description: { url: request.url, method: request.method, headers },
		body,
		signal: init?.signal ?? undefined,
	};
}

/**
 * Send one request through the shell. A cross-origin redirect is not
 * followed (`http.rs`), so a key never leaves for another host. Withdrawing
 * `init.signal` rejects at once; the request already sent is not recalled.
 */
export async function shellFetch(
	input: string | URL | Request,
	init?: RequestInit,
): Promise<Response> {
	const { description, body, signal } = await describe(input, init);
	signal?.throwIfAborted();
	const sent = invoke<Answer>('send_request', body, {
		headers: {
			'x-whispering-request': encodeURIComponent(JSON.stringify(description)),
		},
	});
	const answer = await (signal
		? Promise.race([
				sent,
				new Promise<never>((_, reject) =>
					signal.addEventListener('abort', () => reject(signal.reason), {
						once: true,
					}),
				),
			])
		: sent
	).catch((cause: unknown) => {
		// Tauri rejects with the command's error string; fetch rejects with a TypeError.
		throw cause instanceof Error ? cause : new TypeError(String(cause));
	});
	const status = answer.status;
	// A redirect the shell stopped at is a network error, as `redirect: 'error'` asks.
	if (status >= 300 && status < 400 && init?.redirect !== 'manual')
		throw new TypeError(
			`${description.url} answered with a redirect, which was not followed.`,
		);
	const nullBody = status === 204 || status === 205 || status === 304;
	return new Response(nullBody ? null : fromBase64(answer.body), {
		status,
		statusText: answer.statusText,
		headers: answer.headers,
	});
}
