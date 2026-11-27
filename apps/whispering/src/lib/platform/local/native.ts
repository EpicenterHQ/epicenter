/**
 * Local transcription in the desktop app: the transcription plugin's model
 * commands (`tauri-plugin-epicenter-transcription`), and the app's own
 * `transcribe_local` (`local.rs`), which reads the recording in Rust.
 */
import { Channel, invoke } from '@tauri-apps/api/core';
import { Err, tryAsync } from 'wellcrafted/result';
import {
	type Local,
	type LocalError,
	LocalFailure,
	type LocalModel,
} from './local';

const plugin = (command: string) => `plugin:epicenter-transcription|${command}`;

/**
 * What a command rejected with, as a message. The plugin rejects with
 * `{ name, message }`; an IPC failure arrives as a string.
 */
function messageOf(cause: unknown): unknown {
	return typeof cause === 'object' && cause !== null && 'message' in cause
		? cause.message
		: cause;
}

const run = <T>(command: string, args: Record<string, unknown>) =>
	tryAsync({
		try: () => invoke<T>(command, args),
		catch: (cause) => LocalFailure.Failed({ cause: messageOf(cause) }),
	});

/** Whether `cause` is the error `transcribe_local` rejected with. */
function isLocalError(cause: unknown): cause is LocalError {
	return (
		typeof cause === 'object' &&
		cause !== null &&
		'name' in cause &&
		'message' in cause
	);
}

export const nativeLocal: Local = {
	available: true,

	models: () => run<LocalModel[]>(plugin('list_models'), {}),

	download(id, onProgress) {
		const progress = new Channel<{
			bytesReceived: number;
			totalBytes: number;
		}>(({ bytesReceived, totalBytes }) =>
			onProgress(totalBytes > 0 ? bytesReceived / totalBytes : 0),
		);
		return run<void>(plugin('download_model'), {
			modelId: id,
			onProgress: progress,
		});
	},

	remove: (id) => run<void>(plugin('remove_model'), { modelId: id }),

	reveal: (id) => run<void>(plugin('reveal_model'), { modelId: id }),

	transcribe: (id, model, { prompt, language }) =>
		tryAsync({
			try: () =>
				invoke<string>('transcribe_local', {
					id,
					model,
					prompt: prompt ?? null,
					language: language ?? null,
				}),
			catch: (cause) =>
				isLocalError(cause) ? Err(cause) : LocalFailure.Failed({ cause }),
		}),
};
