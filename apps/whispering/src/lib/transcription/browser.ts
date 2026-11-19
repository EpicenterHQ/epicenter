/**
 * Transcription in a browser: the page sends the recording itself, with
 * `fetch`, as `transcribe.rs` does on the desktop, and answers the same
 * errors.
 *
 * The API key is kept in the page's `localStorage`, one per server origin.
 * A browser has no Keychain, so the page holds the key; it never leaves for
 * any server but the one it is kept for.
 *
 * The server must allow requests from a web page (CORS). OpenAI's does; a
 * server that does not looks the same as one that cannot be reached.
 */
import { Err, Ok } from 'wellcrafted/result';
import type { Files } from '../files/files';
import { originOf } from '../transcription-server';
import {
	type TranscribeError,
	type Transcription,
	TranscriptionError,
} from './transcription';

/** How long a transcription may take in all: a long recording on a slow server takes minutes. */
const TIMEOUT_MS = 5 * 60 * 1000;
/** The extensions a recording's audio may have, as `data/recordings.ts` lists them. */
const AUDIO = ['webm', 'm4a'];

const keyName = (baseUrl: string) =>
	`whispering:key:${originOf(baseUrl) ?? baseUrl}`;

const fail = (error: TranscribeError) => Err(error);

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

export function createBrowserTranscription(files: Files): Transcription {
	return {
		keyKeptIn: 'this browser',

		async transcribe(id, { baseUrl, model }) {
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

			const endpoint = `${baseUrl.replace(/\/+$/, '')}/audio/transcriptions`;
			const form = new FormData();
			form.append('model', model);
			form.append('file', audio.blob, audio.name);
			const key = localStorage.getItem(keyName(baseUrl));

			let response: Response;
			try {
				response = await fetch(endpoint, {
					method: 'POST',
					body: form,
					headers: key ? { Authorization: `Bearer ${key}` } : {},
					signal: AbortSignal.timeout(TIMEOUT_MS),
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
			const text = parseText(body);
			if (text === undefined)
				return fail({
					name: 'BadResponse',
					message: `The server's answer had no text: ${body.slice(0, 200)}`,
				});
			return Ok(text);
		},

		async setKey(baseUrl, key) {
			try {
				if (key) localStorage.setItem(keyName(baseUrl), key);
				else localStorage.removeItem(keyName(baseUrl));
				return Ok(undefined);
			} catch (cause) {
				return TranscriptionError.KeyFailed({ cause });
			}
		},

		async hasKey(baseUrl) {
			try {
				return Ok(localStorage.getItem(keyName(baseUrl)) !== null);
			} catch (cause) {
				return TranscriptionError.KeyFailed({ cause });
			}
		},
	};
}

/** The trimmed `text` of a successful answer, or undefined when it has none. */
function parseText(body: string): string | undefined {
	try {
		const { text } = JSON.parse(body);
		return typeof text === 'string' ? text.trim() : undefined;
	} catch {
		return undefined;
	}
}
