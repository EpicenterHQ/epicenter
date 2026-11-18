/**
 * Recording in the desktop app, through `tauri-plugin-epicenter-recorder`
 * (ADR-0962).
 *
 * The shell's recorder encodes the microphone to Opus from the first sample
 * and writes it, a second at a time, at `recordings/<id>.webm` in the
 * folder (ADR-0962). It refuses a folder the app's grant does not hold, and
 * an id whose audio is already there. `stop` finishes the take in place.
 * When the page reloads or its window closes, the shell finishes the
 * recording itself: the audio is kept. A process that ends before then
 * leaves the take with every whole second but the last, which plays as it
 * is.
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
import { Channel } from '@tauri-apps/api/core';
import { Ok } from 'wellcrafted/result';
import {
	commands,
	type RecorderError as NativeRecorderError,
	type RecordingSignal,
} from './native/bindings.gen.js';
import { type AudioFiles, type Recorder, RecorderError } from './recording.js';
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

/** The folder's path, which the shell records into, or why there is none. */
function locationOf(files: AudioFiles) {
	if (files.location === null)
		return RecorderError.Refused({ reason: 'the folder has no path here' });
	return Ok(files.location);
}

/** Record at `recordings/<id>.webm` from its first second, finished there when it stops. */
const start: Recorder['start'] = async ({ files, id, input, signal }) => {
	if (signal?.aborted) return RecorderError.Cancelled();
	const folder = locationOf(files);
	if (folder.error !== null) return folder;
	const signals = nativeSignals();
	let answer: Awaited<ReturnType<typeof commands.start>>;
	try {
		answer = await commands.start(
			folder.data,
			id,
			input?.deviceId ?? null,
			signals.channel,
		);
	} catch (cause) {
		return RecorderError.Failed({ cause });
	}
	if (answer.error !== null) return fromNative(answer.error, input?.label);
	// Withdrawn while the shell was opening the microphone: it is released,
	// and what the shell already wrote is finished and kept, never deleted.
	if (signal?.aborted) {
		signals.retire();
		await commands.stop().catch(() => {});
		return RecorderError.Cancelled();
	}
	return Ok({
		onEnded: signals.onEnded,
		async stop() {
			signals.retire();
			try {
				const { data, error } = await commands.stop();
				if (error !== null) return fromNative(error);
				return Ok(data);
			} catch (cause) {
				return RecorderError.Failed({ cause });
			}
		},
	});
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

/** The shell's microphones, recording into the folder the page names. */
export const recorder = {
	start,
	listInputs,
	openMeter,
} satisfies Recorder;
