/**
 * The app's native transcription commands (`transcribe.rs`, `keys.rs`). Rust
 * reads the audio, holds the API key and talks to the server; the page passes
 * a recording's id and the server's address, and never sees the key.
 */
import { invoke } from '@tauri-apps/api/core';
import {
	defineErrors,
	extractErrorMessage,
	type InferErrors,
} from 'wellcrafted/error';
import { Err, tryAsync } from 'wellcrafted/result';
import type { Server } from './transcription-server';

/** Why `transcribe` gave no text, as `TranscribeError` in `transcribe.rs` says it. */
export type TranscribeError =
	| { name: 'NoAudio'; message: string }
	| { name: 'Unauthorized'; message: string }
	| { name: 'Rejected'; status: number; message: string }
	| { name: 'Unreachable'; message: string }
	| { name: 'BadResponse'; message: string }
	| { name: 'KeyUnreadable'; message: string };

const NAMES = new Set<string>([
	'NoAudio',
	'Unauthorized',
	'Rejected',
	'Unreachable',
	'BadResponse',
	'KeyUnreadable',
] satisfies TranscribeError['name'][]);

function isTranscribeError(cause: unknown): cause is TranscribeError {
	return (
		typeof cause === 'object' &&
		cause !== null &&
		'name' in cause &&
		typeof cause.name === 'string' &&
		NAMES.has(cause.name) &&
		'message' in cause
	);
}

export const TranscriptionError = defineErrors({
	/** The command failed in a way `transcribe.rs` does not name. */
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

export const transcription = {
	/** The text of the recording `id`, from `server`. */
	transcribe: (id: string, { baseUrl, model }: Server) =>
		tryAsync({
			try: () => invoke<string>('transcribe', { id, baseUrl, model }),
			catch: (cause) =>
				isTranscribeError(cause)
					? Err(cause)
					: TranscriptionError.Failed({ cause }),
		}),

	/** Keep `key` for the server at `baseUrl`; an empty key forgets the one kept. */
	setKey: (baseUrl: string, key: string) =>
		tryAsync({
			try: () => invoke<void>('key_set', { baseUrl, key }),
			catch: (cause) => TranscriptionError.KeyFailed({ cause }),
		}),

	/** Whether a key is kept for the server at `baseUrl`. */
	hasKey: (baseUrl: string) =>
		tryAsync({
			try: () => invoke<boolean>('key_exists', { baseUrl }),
			catch: (cause) => TranscriptionError.KeyFailed({ cause }),
		}),
};
