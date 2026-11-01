/**
 * Recording in the desktop app, through `tauri-plugin-epicenter-recorder`
 * (ADR-0543, decision 84).
 *
 * The shell's recorder encodes the microphone to Opus from the first sample
 * and writes it, a second at a time, into a WebM in the `device`'s folder's
 * own `.epicenter/recordings`, a hidden path no watcher reports and sync
 * never commits. The folder is named to the shell by the root it answered
 * when the page opened the device (`rootOf` from `@epicenter/folder/tauri`).
 * `stop` finishes it in place and places it at `<path>.webm`, never over a
 * file there, so the recording appears at its path whole, and answers where
 * it is. When the page reloads or its window closes, the shell finishes and
 * places the recording itself: the audio is kept. A process that ends
 * before then leaves the file in `.epicenter/recordings` with every whole
 * second but the last; `recoverRecordings` finishes it from those and
 * places it at its path.
 *
 * Levels and an ending nobody asked for arrive on a channel this page alone
 * hears.
 *
 * The page opens no microphone of its own: the shell lists the inputs
 * (`listInputs`), reads one's level without recording (`openMeter`), and
 * records from one, each named by the id the shell lists it under.
 */
import { rootOf } from '@epicenter/folder/tauri';
import { Channel } from '@tauri-apps/api/core';
import { Ok, type Result } from 'wellcrafted/result';
import {
	commands,
	type Input,
	type RecorderError as NativeRecorderError,
	type RecordingSignal,
} from './native/bindings.gen.js';
import {
	type OpenMeter,
	RecorderError,
	type RecordingEndedReason,
	type RecoverRecordings,
	type StartRecording,
} from './recording.js';

export * from './recording.js';
export type { Input };

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

/** One native channel owns its listeners and first ending until retired. */
function createRecordingSignals() {
	const levels = new Set<(level: number) => void>();
	const endings = new Set<(reason: RecordingEndedReason) => void>();
	let ended: RecordingEndedReason | undefined;
	let retired = false;
	const channel = new Channel<RecordingSignal>();
	channel.onmessage = (message) => {
		if (retired) return;
		if (message.kind === 'level') {
			for (const listener of levels) listener(message.level ?? 0);
		} else if (ended === undefined) {
			const reason = message.reason;
			ended = reason;
			for (const listener of [...endings]) listener(reason);
		}
	};
	return {
		channel,
		onLevel(listener: (level: number) => void) {
			if (retired) return () => {};
			levels.add(listener);
			return () => levels.delete(listener);
		},
		onEnded(listener: (reason: RecordingEndedReason) => void) {
			if (retired) return () => {};
			if (ended !== undefined) {
				listener(ended);
				return () => {};
			}
			endings.add(listener);
			return () => endings.delete(listener);
		},
		retire() {
			retired = true;
			levels.clear();
			endings.clear();
		},
	};
}

/** Record into `device`'s folder from the first sample, landing at `<path>.webm` when it stops. */
export const startRecording: StartRecording = async ({
	device,
	path,
	input,
	signal,
}) => {
	if (signal?.aborted) return RecorderError.Cancelled();
	const signals = createRecordingSignals();
	let answer: Awaited<ReturnType<typeof commands.start>>;
	try {
		answer = await commands.start(
			rootOf(device),
			path,
			input?.deviceId ?? null,
			signals.channel,
		);
	} catch (cause) {
		return RecorderError.Failed({ cause });
	}
	if (answer.error !== null) return fromNative(answer.error, input?.label);
	const { id, device: microphone } = answer.data;
	// Withdrawn while the shell was opening the microphone: it is released,
	// and what the shell already wrote is finalized and kept, never deleted.
	if (signal?.aborted) {
		signals.retire();
		await commands.stop(id).catch(() => {});
		return RecorderError.Cancelled();
	}
	const startedAt = Date.now();

	return Ok({
		startedAt,
		microphone,
		onLevel: signals.onLevel,
		onEnded: signals.onEnded,
		async stop() {
			signals.retire();
			try {
				const { data, error } = await commands.stop(id);
				if (error !== null) return fromNative(error);
				return Ok(data);
			} catch (cause) {
				return RecorderError.Failed({ cause });
			}
		},
	});
};

/**
 * Finish every recording a quit or a crash left in the folder's
 * `.epicenter/recordings` under `under` from its whole seconds, and place
 * it at its path. Answers each one placed, with how long it plays. Run it
 * before anything lists, plays, or transcribes a recording.
 */
export const recoverRecordings: RecoverRecordings = async ({
	device,
	under,
}) => {
	try {
		const { data, error } = await commands.recover(rootOf(device), under);
		if (error !== null) return fromNative(error);
		return Ok(data);
	} catch (cause) {
		return RecorderError.Failed({ cause });
	}
};

/** The microphones connected now, each with the id to record or meter it by. Opens nothing. */
export async function listInputs(): Promise<Result<Input[], RecorderError>> {
	try {
		const { data, error } = await commands.inputs();
		if (error !== null) return fromNative(error);
		return Ok(data);
	} catch (cause) {
		return RecorderError.Failed({ cause });
	}
}

/**
 * Open `input`, or the system default, for its level until `close`. The
 * shell also closes it when this page reloads or its window closes. A chosen
 * input that is not connected is refused, never replaced.
 */
export const openMeter: OpenMeter = async ({ input, signal } = {}) => {
	if (signal?.aborted) return RecorderError.Cancelled();
	const signals = createRecordingSignals();
	let answer: Awaited<ReturnType<typeof commands.openMeter>>;
	try {
		answer = await commands.openMeter(input?.deviceId ?? null, signals.channel);
	} catch (cause) {
		return RecorderError.Failed({ cause });
	}
	if (answer.error !== null) return fromNative(answer.error, input?.label);
	const { id, device: microphone } = answer.data;
	const close = async () => {
		signals.retire();
		await commands.closeMeter(id).catch(() => {});
	};
	if (signal?.aborted) {
		await close();
		return RecorderError.Cancelled();
	}
	return Ok({
		microphone,
		onLevel: signals.onLevel,
		onEnded: signals.onEnded,
		close,
	});
};
