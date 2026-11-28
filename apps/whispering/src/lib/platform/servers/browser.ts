/**
 * Servers in a browser: the page sends each request itself, with `fetch`,
 * as `servers.rs` does on the desktop, and answers the same errors.
 *
 * The API key is kept in the page's `localStorage`, one per server origin.
 * A browser has no Keychain, so the page holds the key; it never leaves for
 * any server but the one it is kept for.
 *
 * The server must allow requests from a web page (CORS). OpenAI's and
 * Groq's do; a server that does not looks the same as one that cannot be
 * reached.
 */
import { extractErrorMessage } from 'wellcrafted/error';
import { Err, Ok, type Result } from 'wellcrafted/result';
import { originOf } from '../../transcription-server';
import type { Files } from '../files/files';
import { type ServerError, type Servers, ServersError } from './servers';

/** How long a transcription may take in all: a long recording on a slow server takes minutes. */
const TRANSCRIBE_TIMEOUT_MS = 5 * 60 * 1000;
/** The extensions a recording's audio may have, as `data/recordings.ts` lists them. */
const AUDIO = ['webm', 'm4a'];

const keyName = (baseUrl: string) =>
	`whispering:key:${originOf(baseUrl) ?? baseUrl}`;

const fail = (error: ServerError) => Err(error);

/** What an error body says: `error.message` in OpenAI's shape, a plain `error`, or FastAPI's `detail`. */
function serverMessage(body: string): string | undefined {
	try {
		const value = JSON.parse(body);
		const said = value?.error?.message ?? value?.error ?? value?.detail;
		return typeof said === 'string' && said.trim() ? said.trim() : undefined;
	} catch {
		return undefined;
	}
}

/**
 * Post `body` to `<baseUrl><path>` with the key kept for its origin, and
 * read the text `read` finds in a successful answer.
 */
async function post(
	baseUrl: string,
	path: string,
	init: { body: BodyInit; headers?: Record<string, string> },
	timeoutMs: number,
	read: (body: string) => string | undefined,
): Promise<Result<string, ServerError>> {
	const endpoint = `${baseUrl.replace(/\/+$/, '')}${path}`;
	let key: string | null;
	try {
		key = localStorage.getItem(keyName(baseUrl));
	} catch (cause) {
		return fail({
			name: 'KeyUnreadable',
			message: `The API key could not be read from this browser: ${extractErrorMessage(cause)}`,
		});
	}
	let response: Response;
	try {
		response = await fetch(endpoint, {
			method: 'POST',
			body: init.body,
			headers: {
				...init.headers,
				...(key ? { Authorization: `Bearer ${key}` } : {}),
			},
			signal: AbortSignal.timeout(timeoutMs),
		});
	} catch (cause) {
		return fail({
			name: 'Unreachable',
			message:
				cause instanceof DOMException && cause.name === 'TimeoutError'
					? `${endpoint} did not answer in time.`
					: `${endpoint} could not be reached. It may be down, or it may not accept requests from a web page.`,
		});
	}
	const body = await response.text();
	const { status } = response;
	if (status === 401 || status === 403) {
		const reason = serverMessage(body);
		return fail({
			name: 'Unauthorized',
			message: reason
				? `The server did not accept the API key: ${reason}`
				: `The server did not accept the API key (${status}).`,
		});
	}
	if (!response.ok)
		return fail({
			name: 'Rejected',
			status,
			message: `The server answered ${status}: ${serverMessage(body) ?? body.slice(0, 200)}`,
		});
	const text = read(body);
	if (text === undefined)
		return fail({
			name: 'BadResponse',
			message: `The server's answer had no text: ${body.slice(0, 200)}`,
		});
	return Ok(text);
}

/** The fields of a transcription's or a chat's answer this page reads. */
type Answer = {
	text?: unknown;
	choices?: { message?: { content?: unknown } }[];
};

/** `read` applied to `body` as JSON, trimmed, or undefined when it is not text. */
function fromJson(body: string, read: (value: Answer) => unknown) {
	try {
		const text = read(JSON.parse(body));
		return typeof text === 'string' ? text.trim() : undefined;
	} catch {
		return undefined;
	}
}

export function createBrowserServers(files: Files): Servers {
	return {
		keyKeptIn: 'this browser',

		async transcribe(id, { baseUrl, model }, { prompt, language }) {
			let audio: { blob: Blob; name: string } | undefined;
			for (const extension of AUDIO) {
				const url = await files.url(`recordings/${id}.${extension}`);
				if (url.error) continue;
				audio = {
					blob: await (await fetch(url.data)).blob(),
					name: `${id}.${extension}`,
				};
				break;
			}
			if (!audio)
				return fail({
					name: 'NoAudio',
					message: "This recording's audio is gone.",
				});
			const form = new FormData();
			form.append('model', model);
			if (prompt) form.append('prompt', prompt);
			if (language) form.append('language', language);
			form.append('file', audio.blob, audio.name);
			return post(
				baseUrl,
				'/audio/transcriptions',
				{ body: form },
				TRANSCRIBE_TIMEOUT_MS,
				(body) => fromJson(body, (value) => value.text),
			);
		},

		complete: ({ baseUrl, model }, { instructions, text, timeoutMs }) =>
			post(
				baseUrl,
				'/chat/completions',
				{
					body: JSON.stringify({
						model,
						temperature: 0,
						messages: [
							{ role: 'system', content: instructions },
							{ role: 'user', content: text },
						],
					}),
					headers: { 'Content-Type': 'application/json' },
				},
				timeoutMs,
				(body) =>
					fromJson(body, (value) => value.choices?.[0]?.message?.content),
			),

		async setKey(baseUrl, key) {
			try {
				if (key) localStorage.setItem(keyName(baseUrl), key);
				else localStorage.removeItem(keyName(baseUrl));
				return Ok(undefined);
			} catch (cause) {
				return ServersError.KeyFailed({ cause });
			}
		},

		async hasKey(baseUrl) {
			try {
				return Ok(localStorage.getItem(keyName(baseUrl)) !== null);
			} catch (cause) {
				return ServersError.KeyFailed({ cause });
			}
		},
	};
}
