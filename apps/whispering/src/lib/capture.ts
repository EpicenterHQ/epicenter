/**
 * Audio capture for one recording at a time, into the folder.
 *
 * A capture names its audio file when it starts, so the recording's row can
 * name it from the start too (ADR-0543). The microphone device
 * (`microphone.ts`) records with `@epicenter/recorder`: inside the desktop app
 * the shell owns the microphone and writes the WAV into the folder from the
 * first sample (ADR-0571), and in a browser the page records and writes it on
 * stop. The fixture device exists for
 * repeatable automation: it writes the same bytes every time on stop and
 * marks the recording `fixture`, so a fixture take is never stored as a
 * microphone take. The platform adapter chooses which device a session uses;
 * nothing here falls back from one to the other.
 */
import type { Recording, RecordingFolder } from '@epicenter/recorder';
import { defineErrors, type InferErrors } from 'wellcrafted/error';
import { Ok, type Result } from 'wellcrafted/result';
import { extensionOf, wavDurationMs } from './audio-format.js';
import type { CaptureSource } from './definition.js';

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
	/** The audio could not be written into the folder. */
	NotSaved: ({ reason }: { reason: string }) => ({
		message: `The recording could not be saved to the folder: ${reason}`,
		reason,
	}),
});
export type CaptureError = InferErrors<typeof CaptureError>;

export type ActiveCapture = {
	/**
	 * The audio file this recording is, folder-relative, such as
	 * `recordings/20260102-030405-k3f9.wav`. Named before anything is
	 * captured, so playback can find it before the next folder listing.
	 */
	readonly audioPath: string;
	/** `performance.now()` when capture began, for the elapsed-time display. */
	readonly startedAt: number;
	/** Hear capture end unexpectedly; stop still keeps its audio. Retired by stop. */
	onEnded: Recording['onEnded'];
	/**
	 * Finish the audio file and release the microphone. Nothing here deletes
	 * a capture: one the page leaves without stopping ends with the page.
	 */
	stop(): Promise<Result<{ readonly durationMs: number }, CaptureError>>;
};

/** A microphone the person chose by name. Kept on this device, never in the folder. */
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
	/** The folder the audio is written into. */
	readonly folder: RecordingFolder;
	/** The audio's folder-relative path without an extension; the device adds one. */
	readonly path: string;
	/** The microphone to record from. Undefined is the system default. */
	readonly input?: MicrophonePreference;
	/**
	 * Withdraws the start. A microphone that opens afterward is released; on
	 * the desktop what the shell already wrote is kept, never deleted.
	 */
	readonly signal?: AbortSignal;
};

export type CaptureDevice = {
	readonly source: CaptureSource;
	/** What the person is told this session records from. */
	readonly label: string;
	/** Undefined when this device has no real input to choose or test. */
	readonly inputs: MicrophoneInputs | undefined;
	start(options: CaptureStart): Promise<Result<ActiveCapture, CaptureError>>;
};

export type FixtureAudio = {
	readonly name: string;
	readonly bytes: Uint8Array;
};

/**
 * A device that answers every recording with the same fixture bytes, written
 * into the folder on stop under the fixture's own extension. `load` runs at
 * stop, so a missing or unreadable fixture fails that recording instead of
 * the session.
 */
export function createFixtureDevice({
	name,
	load,
}: {
	name: string;
	load: () => Promise<FixtureAudio>;
}): CaptureDevice {
	const extension = extensionOf(name) || 'wav';
	return {
		source: 'fixture',
		label: `Fixture audio (${name})`,
		// No microphone is behind this device, so none is listed, asked for, or opened.
		inputs: undefined,
		async start({ folder, path }) {
			const startedAt = performance.now();
			const audioPath = `${path}.${extension}`;
			let stopped = false;
			return Ok({
				audioPath,
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
					const { error } = await folder.write(audioPath, fixture.bytes);
					if (error !== null)
						return CaptureError.NotSaved({ reason: error.message });
					return Ok({
						// The fixture's own length when it can be read, not the wait before Stop.
						durationMs:
							wavDurationMs(fixture.bytes) ??
							Math.round(performance.now() - startedAt),
					});
				},
			});
		},
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
