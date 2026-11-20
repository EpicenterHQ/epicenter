/**
 * What Whispering asks of the person's OpenAI-compatible servers, in the
 * desktop app (`native.ts`, Rust and the Keychain) and in a browser
 * (`browser.ts`, `fetch` and the page's storage):
 *
 * - `transcribe`: send a recording to `POST <base>/audio/transcriptions`.
 * - `complete`: send text and instructions to `POST <base>/chat/completions`,
 *   which cleanup uses.
 * - `setKey` and `hasKey`: keep each server's API key.
 *
 * A key is kept per server origin and never read back by the page: `hasKey`
 * says whether one is kept, and only the sending side uses it. A cleanup
 * server at the transcription server's origin uses the same key.
 */
import {
	defineErrors,
	extractErrorMessage,
	type InferErrors,
} from 'wellcrafted/error';
import type { Result } from 'wellcrafted/result';
import type { Server } from '../../transcription-server';

/** Why a server gave no text, as `ServerError` in `servers.rs` says it. */
export type ServerError =
	| { name: 'NoAudio'; message: string }
	| { name: 'Unauthorized'; message: string }
	| { name: 'Rejected'; status: number; message: string }
	| { name: 'Unreachable'; message: string }
	| { name: 'BadResponse'; message: string }
	| { name: 'KeyUnreadable'; message: string };

export const ServersError = defineErrors({
	/** The request failed in a way `ServerError` does not name. */
	Failed: ({ cause }: { cause: unknown }) => ({
		message: `The server could not be asked: ${extractErrorMessage(cause)}`,
		cause,
	}),
	KeyFailed: ({ cause }: { cause: unknown }) => ({
		message: extractErrorMessage(cause),
		cause,
	}),
});
export type ServersError = InferErrors<typeof ServersError>;

/** What `complete` sends: instructions, and the text they apply to. */
export type Completion = {
	/** The system message: what to do with `text`. */
	instructions: string;
	/** The user message, alone, so nothing else in it reads as text to change. */
	text: string;
	/** How long the server may take before the request is given up. */
	timeoutMs: number;
};

export type Servers = {
	/** Where a key is kept, as a person reads it: "the macOS Keychain". */
	keyKeptIn: string;
	/**
	 * The text of the recording `id`, from `server`. `prompt`, when given,
	 * goes as the request's `prompt`: words the server should spell as given.
	 */
	transcribe(
		id: string,
		server: Server,
		prompt: string | undefined,
	): Promise<Result<string, ServerError | ServersError>>;
	/** The answer of the chat model `server` to `completion`, trimmed. */
	complete(
		server: Server,
		completion: Completion,
	): Promise<Result<string, ServerError | ServersError>>;
	/** Keep `key` for the server at `baseUrl`; an empty key forgets the one kept. */
	setKey(baseUrl: string, key: string): Promise<Result<void, ServersError>>;
	/** Whether a key is kept for the server at `baseUrl`. */
	hasKey(baseUrl: string): Promise<Result<boolean, ServersError>>;
};
