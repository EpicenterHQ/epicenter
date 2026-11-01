/**
 * Recording in the desktop app, through `tauri-plugin-epicenter-recorder`
 * (ADR-0543, decision 84).
 *
 * The shell's recorder writes a WAV from the first sample into the
 * `device`'s folder's own `.epicenter/recordings`, a hidden path no watcher
 * reports and sync never commits, its header updated about once a second.
 * The folder is
 * named to the shell by the root it answered when the page opened the device
 * (`rootOf` from `@epicenter/folder/tauri`). `stop` finalizes it and answers;
 * the shell then encodes it to Opus in WebM and places that at
 * `<path>.webm`, never over a file there, so the recording appears at its
 * path whole, and `placed` says where. (A WAV the encoder refuses is placed
 * at `<path>.wav` instead, and `placed` says why.) When the page reloads
 * or its window closes, the shell finalizes and places the recording
 * itself: the audio is kept. A
 * process that ends before then leaves the WAV in `.epicenter/recordings`
 * with a header that undercounts the last second; `recoverRecordings`
 * rewrites it from the file's length, encodes it, and places it at its path.
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
	type Placement,
	type RecordingSignal,
} from './native/bindings.gen.js';
import {
	type OpenMeter,
	type PlacedRecording,
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

/** Where the shell placed a stopped recording, as this package says it. */
function placedOf(
	placement: Placement,
): Result<PlacedRecording, RecorderError> {
	switch (placement.kind) {
		case 'placed':
			return Ok({ path: placement.path });
		case 'unencoded':
			return Ok({ path: placement.path, unencoded: placement.reason });
		case 'pending':
			return RecorderError.Failed({ cause: placement.reason });
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
		await commands.stop(id, new Channel()).catch(() => {});
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
			const placement = new Channel<Placement>();
			const placed = new Promise<Result<PlacedRecording, RecorderError>>(
				(resolve) => {
					placement.onmessage = (message) => resolve(placedOf(message));
				},
			);
			try {
				const { data, error } = await commands.stop(id, placement);
				if (error !== null) return fromNative(error);
				return Ok({ durationMs: data.durationMs, placed });
			} catch (cause) {
				return RecorderError.Failed({ cause });
			}
		},
	});
};

/**
 * Repair every WAV a quit or a crash left in the folder's
 * `.epicenter/recordings` under `under`, encode each, and place it at its
 * path (or beside it, `<name>-recovered.webm`, when the path is taken).
 * Answers each one placed, with how long it plays from its WAV's samples.
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
