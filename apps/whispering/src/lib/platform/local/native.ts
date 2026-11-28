/**
 * Local transcription in the desktop app: the transcription plugin's model
 * commands (`tauri-plugin-epicenter-transcription`), through its generated
 * bindings, and the app's own `transcribe_local` (`local.rs`), which reads
 * the recording in Rust.
 */
import {
	commands,
	type DownloadProgress,
} from '@epicenter/transcription/bindings';
import { Channel, invoke } from '@tauri-apps/api/core';
import { Err, tryAsync } from 'wellcrafted/result';
import {
	type Local,
	type LocalError,
	LocalFailure,
	type LocalModel,
} from './local';

/**
 * What a command refused or rejected with, as a message. The plugin refuses
 * with `{ name, message }`; an IPC failure arrives as a string.
 */
function messageOf(cause: unknown): unknown {
	return typeof cause === 'object' && cause !== null && 'message' in cause
		? cause.message
		: cause;
}

const failed = (cause: unknown) =>
	LocalFailure.Failed({ cause: messageOf(cause) });

/** Run a model command that answers nothing; its refusal is a `Failed`. */
const act = (command: () => Promise<{ error: unknown }>) =>
	tryAsync({
		try: async () => {
			const { error } = await command();
			if (error !== null) throw error;
		},
		catch: failed,
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

	models: () =>
		tryAsync({
			try: async (): Promise<LocalModel[]> =>
				(await commands.listModels()).map((model) => ({
					...model,
					sizeBytes: model.sizeBytes ?? 0,
				})),
			catch: failed,
		}),

	download(id, onProgress) {
		const progress = new Channel<DownloadProgress>(
			({ bytesReceived, totalBytes }) =>
				onProgress(
					totalBytes && bytesReceived ? bytesReceived / totalBytes : 0,
				),
		);
		return act(() => commands.downloadModel(id, progress));
	},

	remove: (id) => act(() => commands.removeModel(id)),

	reveal: (id) => act(() => commands.revealModel(id)),

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
