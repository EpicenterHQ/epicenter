/**
 * Transcription in the desktop app, through its own commands
 * (`transcribe.rs`, `keys.rs`). Rust reads the audio, keeps the API key in
 * the Keychain and talks to the server; the page passes a recording's id
 * and the server's address, and never holds the key.
 */
import { invoke } from '@tauri-apps/api/core';
import { Err, tryAsync } from 'wellcrafted/result';
import {
	type TranscribeError,
	type Transcription,
	TranscriptionError,
} from './transcription';

/**
 * Whether `cause` is the error `transcribe` rejected with. Tauri rejects a
 * command with the error it serialized; an IPC failure arrives as a string.
 */
function isTranscribeError(cause: unknown): cause is TranscribeError {
	return (
		typeof cause === 'object' &&
		cause !== null &&
		'name' in cause &&
		'message' in cause
	);
}

export const nativeTranscription: Transcription = {
	keyKeptIn: 'the macOS Keychain',

	transcribe: (id, { baseUrl, model }) =>
		tryAsync({
			try: () => invoke<string>('transcribe', { id, baseUrl, model }),
			catch: (cause) =>
				isTranscribeError(cause)
					? Err(cause)
					: TranscriptionError.Failed({ cause }),
		}),

	setKey: (baseUrl, key) =>
		tryAsync({
			try: () => invoke<void>('key_set', { baseUrl, key }),
			catch: (cause) => TranscriptionError.KeyFailed({ cause }),
		}),

	hasKey: (baseUrl) =>
		tryAsync({
			try: () => invoke<boolean>('key_exists', { baseUrl }),
			catch: (cause) => TranscriptionError.KeyFailed({ cause }),
		}),
};
