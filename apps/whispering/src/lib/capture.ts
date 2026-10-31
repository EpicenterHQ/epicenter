/**
 * Audio capture for one recording at a time. Every capture writes the
 * recording's audio into Whispering's store as it records, at the path the
 * recording's id names (`recordings/<id>.<ext>`), so a quit, a crash, or a
 * closed tab keeps everything up to the cut (decision 84): on the desktop
 * the shell writes a WAV from the first sample, in a browser each piece is
 * appended to this browser's files as it arrives. Stop answers how long it
 * ran, and `recover` repairs the audio a cut left half-written.
 *
 * The microphone device (`microphone.ts`) records with `@epicenter/recorder`,
 * whose entry the build's platform leaf imports. A fixture device stands in
 * for a microphone in automation and marks the recording `fixture`, so a
 * fixture take is never stored as a microphone take. The platform adapter
 * chooses which device a session uses; nothing here falls back from one to
 * the other.
 */
import type { Client } from '@epicenter/definition/contract';
import { audioDurationMs, type RecordingHandle } from '@epicenter/recorder';
import { defineErrors, type InferErrors } from 'wellcrafted/error';
import { Ok, type Result } from 'wellcrafted/result';
import { extensionOf } from './audio-format.js';
import type { Whispering } from './contract.js';

/** Where a recording's audio came from: a microphone, or a fixture standing in for one. */
export type CaptureSource = 'microphone' | 'fixture';

export const CaptureError = defineErrors({
	Unavailable: ({ reason }: { reason: string }) => ({
		message: `Recording is not available here: ${reason}`,
		reason,
	}),
	PermissionDenied: () => ({
		message:
			'Microphone access was denied. Allow microphone access in System Settings, under Privacy and Security, or in this browser’s site settings, then try again.',
	}),
	/**
	 * The microphone the person chose cannot be opened. Nothing was captured
	 * from any other microphone in its place.
	 */
	InputUnavailable: ({ label }: { label: string }) => ({
		message: `${label === '' ? 'The chosen microphone' : `“${label}”`} is not available, and no other microphone was used in its place. Connect it, or choose another input.`,
		label,
	}),
	/**
	 * The request was withdrawn. A microphone that answered late was released;
	 * on the desktop what a late recording had written was kept.
	 */
	Cancelled: () => ({
		message: 'The request was withdrawn before it finished.',
	}),
	Failed: ({ cause }: { cause: unknown }) => ({
		message: `The recording could not be captured: ${cause instanceof Error ? cause.message : String(cause)}`,
		cause,
	}),
	Empty: () => ({
		message: 'The recording contained no audio.',
	}),
	/** Whispering's files may not be written there: a private window keeps none. */
	Refused: ({ reason }: { reason: string }) => ({
		message: `The recording could not be saved: ${reason}`,
		reason,
	}),
});
export type CaptureError = InferErrors<typeof CaptureError>;

/** A recording being written into Whispering's files. */
export type Capture = {
	/** `performance.now()` when capture began, for the elapsed-time display. */
	readonly startedAt: number;
	/** Hear capture end unexpectedly; stop still keeps what was captured. Retired by stop. */
	onEnded: RecordingHandle<unknown>['onEnded'];
	/**
	 * Finish the file and release the microphone. Answers how long it ran;
	 * the audio is already in the files.
	 */
	stop(): Promise<Result<{ readonly durationMs: number }, CaptureError>>;
};

/** A microphone the person chose by name. Kept on this device, never in Whispering's files. */
export type MicrophonePreference = {
	/** The ID its platform lists it under: the shell's in Epicenter, the WebView's in a browser. Capture asks for exactly this one. */
	readonly deviceId: string;
	/** Its name when it was chosen, shown when it is not connected. */
	readonly label: string;
};

export type MicrophoneListing = {
	/** Inputs that can be chosen by name. Empty until microphone access is allowed. */
	readonly devices: readonly MicrophonePreference[];
	/**
	 * Inputs exist but a WebView withholds their names until access is
	 * allowed. Absent where names are never withheld: Epicenter's shell lists
	 * every input by name, whether or not access was allowed.
	 */
	readonly namesWithheld?: boolean;
};

/** A live reading of one microphone that records, sends, and saves nothing. */
export type MicrophoneMeter = {
	/** The name of the microphone that is open. */
	readonly label: string;
	/** How loud the input is now, from 0 to 1. */
	level(): number;
	/**
	 * Hear that the microphone stopped on its own, such as when it was
	 * unplugged or access was withdrawn, and why. Returns the unsubscribe.
	 */
	onEnded(listener: (error: CaptureError) => void): () => void;
	/** Release the microphone. */
	stop(): void;
};

/** The real inputs behind a capture device. A fixture device has none. */
export type MicrophoneInputs = {
	/**
	 * The inputs connected now. This never asks for access: without it a
	 * WebView lists nothing by name.
	 */
	list(): Promise<Result<MicrophoneListing, CaptureError>>;
	/**
	 * Ask for microphone access so inputs are listed by name. This opens the
	 * system default microphone and releases it at once; nothing is recorded.
	 * Only a WebView has it: in Epicenter the shell asks for access itself
	 * before it opens a microphone, and lists names without it.
	 */
	allow?(signal?: AbortSignal): Promise<Result<undefined, CaptureError>>;
	/**
	 * Open the system's microphone privacy settings, where access that was
	 * denied is allowed again. Absent where the page cannot open them.
	 */
	openSettings?(): Promise<Result<undefined, CaptureError>>;
	/** Open `input`, or the system default, for a level reading only. */
	meter(
		input: MicrophonePreference | undefined,
		signal?: AbortSignal,
	): Promise<Result<MicrophoneMeter, CaptureError>>;
	/**
	 * Hear that inputs were connected or removed. Not every platform says so,
	 * which is why listing again is always offered.
	 */
	onChange(listener: () => void): () => void;
};

export type CaptureStart = {
	/** The recording's id: the audio is written to `recordings/<id>.<ext>`. */
	readonly id: string;
	/** The microphone to record from. Undefined is the system default. */
	readonly input?: MicrophonePreference;
	/** Withdraws the start. A microphone that opens afterward is released. */
	readonly signal?: AbortSignal;
};

/** What records each recording into Whispering's files: the build's services choose one. */
export type CaptureDevice = {
	readonly source: CaptureSource;
	/** What the person is told this session records from. */
	readonly label: string;
	/** Undefined when this device has no real input to choose or test. */
	readonly inputs: MicrophoneInputs | undefined;
	start(options: CaptureStart): Promise<Result<Capture, CaptureError>>;
	/**
	 * Repair the audio of recordings a quit, a crash, or a closed tab cut
	 * off, so each reads to its last whole piece. Answers the ids repaired.
	 */
	recover(): Promise<Result<string[], CaptureError>>;
};

export type FixtureAudio = {
	readonly name: string;
	readonly bytes: Uint8Array;
};

/**
 * A device that keeps the same fixture bytes as every recording, under the
 * fixture's own extension, written into `device` when it stops. `load` runs
 * at stop, so a missing or unreadable fixture fails that recording instead
 * of the session.
 */
export function createFixtureDevice({
	device,
	name,
	load,
}: {
	device: Client<Whispering>;
	name: string;
	load: () => Promise<FixtureAudio>;
}): CaptureDevice {
	const ext = extensionOf(name) || 'wav';
	return {
		source: 'fixture',
		label: `Fixture audio (${name})`,
		// No microphone is behind this device, so none is listed, asked for, or opened.
		inputs: undefined,
		async start({ id }) {
			const startedAt = performance.now();
			let stopped = false;
			return Ok({
				startedAt,
				onEnded: () => () => {},
				async stop() {
					if (stopped) return CaptureError.Empty();
					stopped = true;
					let fixture: FixtureAudio;
					try {
						fixture = await load();
					} catch (cause) {
						return CaptureError.Failed({ cause });
					}
					if (fixture.bytes.byteLength === 0) return CaptureError.Empty();
					const written = await device.audio.create({
						id,
						ext,
						bytes: fixture.bytes,
					});
					if (written.error !== null)
						return CaptureError.Refused({ reason: written.error.message });
					return Ok({
						// The fixture's own length when it can be read, not the wait before Stop.
						durationMs:
							audioDurationMs(fixture.bytes, ext) ??
							Math.round(performance.now() - startedAt),
					});
				},
			});
		},
		recover: async () => Ok([]),
	};
}

/** A one-second 440 Hz mono PCM WAV, for the browser development fixture. */
export function toneWav({
	seconds = 1,
	sampleRate = 16000,
	frequency = 440,
} = {}): Uint8Array {
	const samples = Math.round(seconds * sampleRate);
	const bytes = new Uint8Array(44 + samples * 2);
	const view = new DataView(bytes.buffer);
	const text = (offset: number, value: string) => {
		for (let index = 0; index < value.length; index++)
			view.setUint8(offset + index, value.charCodeAt(index));
	};
	text(0, 'RIFF');
	view.setUint32(4, 36 + samples * 2, true);
	text(8, 'WAVE');
	text(12, 'fmt ');
	view.setUint32(16, 16, true);
	view.setUint16(20, 1, true);
	view.setUint16(22, 1, true);
	view.setUint32(24, sampleRate, true);
	view.setUint32(28, sampleRate * 2, true);
	view.setUint16(32, 2, true);
	view.setUint16(34, 16, true);
	text(36, 'data');
	view.setUint32(40, samples * 2, true);
	for (let index = 0; index < samples; index++)
		view.setInt16(
			44 + index * 2,
			Math.round(
				Math.sin((2 * Math.PI * frequency * index) / sampleRate) * 0x2000,
			),
			true,
		);
	return bytes;
}
