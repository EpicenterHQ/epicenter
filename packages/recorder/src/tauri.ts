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
 * second but the last; `recorder.recover` finishes it from those and
 * places it at its path.
 *
 * An ending nobody asked for, and a meter's levels, arrive on a channel
 * this page alone hears.
 *
 * The page opens no microphone of its own: the shell lists the inputs
 * (`listInputs`), reads one's level without recording (`openMeter`), and
 * records from one, each named by the id the shell lists it under. It has
 * no `allow` and no `onInputsChange`: the shell names every input without
 * microphone access, asks for access itself, and announces no changes.
 */
import { rootOf } from '@epicenter/folder/tauri';
import { Channel } from '@tauri-apps/api/core';
import { Ok } from 'wellcrafted/result';
import {
	commands,
	type RecorderError as NativeRecorderError,
	type RecordingSignal,
} from './native/bindings.gen.js';
import { type Recorder, RecorderError } from './recording.js';
import { createSignals } from './signals.js';

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
			// A reply that is not one of the shell's refusals: Tauri's own, such
			// as a command this window has no permission for.
			return RecorderError.Failed({ cause: error satisfies never });
	}
}

/** A capture's signals, fed by the channel the shell sends them on. */
function nativeSignals() {
	const signals = createSignals();
	const channel = new Channel<RecordingSignal>();
	channel.onmessage = (message) => {
		if (message.kind === 'level') signals.level(message.level ?? 0);
		else signals.end(message.reason);
	};
	return { ...signals, channel };
}

/** Record into `device`'s folder from the first sample, landing at `<path>.webm` when it stops. */
const start: Recorder['start'] = async ({ device, path, input, signal }) => {
	if (signal?.aborted) return RecorderError.Cancelled();
	const signals = nativeSignals();
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
	const id = answer.data;
	// Withdrawn while the shell was opening the microphone: it is released,
	// and what the shell already wrote is finalized and kept, never deleted.
	if (signal?.aborted) {
		signals.retire();
		await commands.stop(id).catch(() => {});
		return RecorderError.Cancelled();
	}
	return Ok({
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
 * it at its path. Answers each one placed, with how long it plays, and each
 * one left there because another file is at its path. Run it before
 * anything lists, plays, or transcribes a recording.
 */
const recover: Recorder['recover'] = async ({ device, under }) => {
	try {
		const { data, error } = await commands.recover(rootOf(device), under);
		if (error !== null) return fromNative(error);
		return Ok(data);
	} catch (cause) {
		return RecorderError.Failed({ cause });
	}
};

/** The microphones connected now, each by the id the shell lists it under. Opens nothing. */
const listInputs: Recorder['listInputs'] = async () => {
	try {
		const { data, error } = await commands.inputs();
		if (error !== null) return fromNative(error);
		return Ok({
			inputs: data.map(({ id, name }) => ({ deviceId: id, label: name })),
		});
	} catch (cause) {
		return RecorderError.Failed({ cause });
	}
};

/**
 * Open `input`, or the system default, for its level until `close`. The
 * shell also closes it when this page reloads or its window closes. A chosen
 * input that is not connected is refused, never replaced.
 */
const openMeter: Recorder['openMeter'] = async ({ input, signal } = {}) => {
	if (signal?.aborted) return RecorderError.Cancelled();
	const signals = nativeSignals();
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

/** The shell's microphones, recording into the data folder the page opened. */
export const recorder = {
	start,
	recover,
	listInputs,
	openMeter,
	placesWhole: true,
} satisfies Recorder;
