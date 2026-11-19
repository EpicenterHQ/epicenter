/**
 * What transcription does, in the desktop app (`native.ts`, Rust and the
 * Keychain) and in a browser (`browser.ts`, `fetch` and the page's storage):
 * send a recording to an OpenAI-compatible `POST <base>/audio/transcriptions`
 * and answer its text, and keep the server's API key.
 *
 * A key is kept per server origin and never read back by the page: `hasKey`
 * says whether one is kept, and only the sending side uses it.
 */
import {
	defineErrors,
	extractErrorMessage,
	type InferErrors,
} from 'wellcrafted/error';
import type { Result } from 'wellcrafted/result';
import type { Server } from '../../transcription-server';

/** Why `transcribe` gave no text, as `TranscribeError` in `transcribe.rs` says it. */
export type TranscribeError =
	| { name: 'NoAudio'; message: string }
	| { name: 'Unauthorized'; message: string }
	| { name: 'Rejected'; status: number; message: string }
	| { name: 'Unreachable'; message: string }
	| { name: 'BadResponse'; message: string }
	| { name: 'KeyUnreadable'; message: string };

export const TranscriptionError = defineErrors({
	/** The transcription failed in a way `TranscribeError` does not name. */
	Failed: ({ cause }: { cause: unknown }) => ({
		message: `The recording could not be transcribed: ${extractErrorMessage(cause)}`,
		cause,
	}),
	KeyFailed: ({ cause }: { cause: unknown }) => ({
		message: extractErrorMessage(cause),
		cause,
	}),
});
export type TranscriptionError = InferErrors<typeof TranscriptionError>;

export type Transcription = {
	/** Where a key is kept, as a person reads it: "the macOS Keychain". */
	keyKeptIn: string;
	/** The text of the recording `id`, from `server`. */
	transcribe(
		id: string,
		server: Server,
	): Promise<Result<string, TranscribeError | TranscriptionError>>;
	/** Keep `key` for the server at `baseUrl`; an empty key forgets the one kept. */
	setKey(
		baseUrl: string,
		key: string,
	): Promise<Result<void, TranscriptionError>>;
	/** Whether a key is kept for the server at `baseUrl`. */
	hasKey(baseUrl: string): Promise<Result<boolean, TranscriptionError>>;
};
