/**
 * Recording in the desktop app, through `tauri-plugin-epicenter-recorder`
 * (ADR-0543, decision 84).
 *
 * The shell's recorder writes `<path>.wav` into the `device`'s folder from
 * the first sample, so the file exists and grows while the recording runs,
 * its header updated about once a second. The folder is named to the shell
 * by the root it answered when the page opened the device (`rootOf` from
 * `@epicenter/folder/tauri`), or, for the window's own folder, by none.
 * `stop` finalizes its header. When the page reloads or its window closes,
 * the shell finalizes the recording itself: the file is kept. A process that
 * ends before then leaves a header that undercounts the last second, which
 * `recoverRecordings` rewrites from the file's length.
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

/** Record into `device`'s folder at `<path>.wav`, from the first sample. */
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
			rootOf(device) ?? null,
			path,
			input?.deviceId ?? null,
			signals.channel,
		);
	} catch (cause) {
		return RecorderError.Failed({ cause });
	}
	if (answer.error !== null) return fromNative(answer.error, input?.label);
	const { id, path: file, device: microphone } = answer.data;
	// Withdrawn while the shell was opening the microphone: it is released,
	// and what the shell already wrote is finalized and kept, never deleted.
	if (signal?.aborted) {
		signals.retire();
		await commands.stop(id).catch(() => {});
		return RecorderError.Cancelled();
	}
	const startedAt = Date.now();

	return Ok({
		path: file,
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

/** Rewrite the header of every WAV under `under` that a quit cut short. */
export const recoverRecordings: RecoverRecordings = async ({
	device,
	under,
}) => {
	try {
		const { data, error } = await commands.recover(
			rootOf(device) ?? null,
			under,
		);
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

/** A microphone open for its level only: nothing is recorded or written. */
export type Meter = {
	/** The name of the microphone that is open. */
	readonly microphone: string;
	/** Hear how loud the input is, from 0 to 1, at most twenty times a second. Returns the unsubscribe. */
	onLevel(listener: (level: number) => void): () => void;
	/** Hear the first unexpected ending, including one before subscription. Retired by close. */
	onEnded(listener: (reason: RecordingEndedReason) => void): () => void;
	/** Release the microphone. */
	close(): Promise<void>;
};

/**
 * Open `input`, or the system default, for its level until `close`. The
 * shell also closes it when this page reloads or its window closes. A chosen
 * input that is not connected is refused, never replaced.
 */
export async function openMeter({
	input,
	signal,
}: {
	input?: { readonly deviceId: string; readonly label: string };
	/** Withdraws the request. A meter that opens afterward is closed. */
	signal?: AbortSignal;
} = {}): Promise<Result<Meter, RecorderError>> {
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
}
