/**
 * Servers in the desktop app, through its own commands (`servers.rs`,
 * `keys.rs`). Rust reads the audio, keeps the API key in the Keychain and
 * talks to the server; the page passes what to send and the server's
 * address, and never holds the key.
 */
import { invoke } from '@tauri-apps/api/core';
import { Err, tryAsync } from 'wellcrafted/result';
import { type ServerError, type Servers, ServersError } from './servers';

/**
 * Whether `cause` is the error a command rejected with. Tauri rejects a
 * command with the error it serialized; an IPC failure arrives as a string.
 */
function isServerError(cause: unknown): cause is ServerError {
	return (
		typeof cause === 'object' &&
		cause !== null &&
		'name' in cause &&
		'message' in cause
	);
}

const asked = <T>(command: string, args: Record<string, unknown>) =>
	tryAsync({
		try: () => invoke<T>(command, args),
		catch: (cause) =>
			isServerError(cause) ? Err(cause) : ServersError.Failed({ cause }),
	});

export const nativeServers: Servers = {
	keyKeptIn: 'the macOS Keychain',

	transcribe: (id, { baseUrl, model }, { prompt, language }) =>
		asked<string>('transcribe', {
			id,
			baseUrl,
			model,
			prompt: prompt ?? null,
			language: language ?? null,
		}),

	complete: ({ baseUrl, model }, { instructions, text, timeoutMs }) =>
		asked<string>('complete', {
			baseUrl,
			model,
			instructions,
			text,
			timeoutMs,
		}),

	setKey: (baseUrl, key) =>
		tryAsync({
			try: () => invoke<void>('key_set', { baseUrl, key }),
			catch: (cause) => ServersError.KeyFailed({ cause }),
		}),

	hasKey: (baseUrl) =>
		tryAsync({
			try: () => invoke<boolean>('key_exists', { baseUrl }),
			catch: (cause) => ServersError.KeyFailed({ cause }),
		}),
};
