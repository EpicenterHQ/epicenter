/**
 * Recording in the desktop app, through `tauri-plugin-epicenter-recorder`.
 *
 * The shell's recorder writes `<path>.wav` into the folder this window was
 * granted from the first sample, so the file exists and grows while the
 * recording runs. `stop` finalizes its header and `cancel` deletes it. When
 * the page reloads or its window closes, the shell finalizes the recording
 * itself: the file is kept and its row, written at start, already names it.
 *
 * Levels and an ending nobody asked for arrive on a channel this page alone
 * hears. The microphone is chosen by the name it gives itself, which is how
 * a WebView labels it too.
 */
import { Channel } from '@tauri-apps/api/core';
import { Ok } from 'wellcrafted/result';
import {
	commands,
	type RecorderError as NativeRecorderError,
	type RecordingSignal,
} from './native/bindings.gen.js';
import {
	RecorderError,
	type RecordingEndedReason,
	type RecoverRecordings,
	type StartRecording,
} from './recording.js';

export * from './recording.js';

/** A refusal from the shell, as this package names it. */
function fromNative(error: NativeRecorderError, label = '') {
	switch (error.name) {
		case 'PermissionDenied':
			return RecorderError.PermissionDenied();
		case 'NoInputDevice':
			return RecorderError.NoInputDevice({ reason: error.message });
		case 'InputUnavailable':
			return RecorderError.InputUnavailable({ label });
		case 'Busy':
			return RecorderError.Busy({ reason: error.message });
		case 'NotRecording':
			return RecorderError.NotRecording({ reason: error.message });
		case 'Refused':
			return RecorderError.Refused({ reason: error.message });
		case 'Failed':
			return RecorderError.Failed({ cause: error.message });
		default:
			// A reply that is not one of the shell's refusals: an older shell, or
			// a command it does not have.
			return RecorderError.Failed({ cause: error satisfies never });
	}
}

export const startRecording: StartRecording = async ({
	folder,
	path,
	input,
	signal,
}) => {
	if (signal?.aborted) return RecorderError.Cancelled();
	const levels = new Set<(level: number) => void>();
	const endings = new Set<(reason: RecordingEndedReason) => void>();
	const signals = new Channel<RecordingSignal>();
	signals.onmessage = (message) => {
		if (message.kind === 'level')
			for (const listener of levels) listener(message.level ?? 0);
		else for (const listener of endings) listener(message.reason);
	};
	let answer: Awaited<ReturnType<typeof commands.start>>;
	try {
		answer = await commands.start(
			folder.id,
			path,
			input?.label ?? null,
			signals,
		);
	} catch (cause) {
		return RecorderError.Failed({ cause });
	}
	if (answer.error !== null) return fromNative(answer.error, input?.label);
	const { id, path: file, device } = answer.data;
	// Withdrawn while the shell was opening the microphone: nothing is kept.
	if (signal?.aborted) {
		await commands.cancel(id).catch(() => {});
		return RecorderError.Cancelled();
	}
	const startedAt = Date.now();
	const silence = () => {
		levels.clear();
		endings.clear();
	};
	return Ok({
		path: file,
		startedAt,
		device,
		onLevel(listener) {
			levels.add(listener);
			return () => levels.delete(listener);
		},
		onEnded(listener) {
			endings.add(listener);
			return () => endings.delete(listener);
		},
		async stop() {
			silence();
			try {
				const { data, error } = await commands.stop(id);
				if (error !== null) return fromNative(error);
				return Ok(data);
			} catch (cause) {
				return RecorderError.Failed({ cause });
			}
		},
		async cancel() {
			silence();
			try {
				const { error } = await commands.cancel(id);
				if (error !== null) return fromNative(error);
				return Ok(undefined);
			} catch (cause) {
				return RecorderError.Failed({ cause });
			}
		},
	});
};

export const recoverRecordings: RecoverRecordings = async ({
	folder,
	under,
}) => {
	try {
		const { data, error } = await commands.recover(folder.id, under);
		if (error !== null) return fromNative(error);
		return Ok(data);
	} catch (cause) {
		return RecorderError.Failed({ cause });
	}
};
