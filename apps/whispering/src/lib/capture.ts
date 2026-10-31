/**
 * Audio capture for one recording at a time, in one of two ways:
 *
 * - In a browser (`CaptureDevice`), a capture holds its audio until Stop,
 *   which answers it: the bytes, the extension they are saved under, and how
 *   long it ran. The app then keeps it as the recording's files.
 * - On the desktop (`FolderCaptureDevice`), the shell writes the recording's
 *   audio into the folder from its first sample (ADR-0543), at the path the
 *   recording's id names, so a quit or a crash keeps everything up to the
 *   cut. Stop answers only how long it ran, and `recover` finishes the
 *   recordings a quit or a crash cut off. The microphone device (`microphone.ts`) records
 * with `@epicenter/recorder`'s browser recorder. A fixture device stands in
 * for a microphone in automation and marks the recording `fixture`, so a
 * fixture take is never stored as a microphone take. The platform adapter
 * chooses which device a session uses; nothing here falls back from one to
 * the other.
 */
import type { RecordingHandle } from '@epicenter/recorder';
import { defineErrors, type InferErrors } from 'wellcrafted/error';
import { Ok, type Result } from 'wellcrafted/result';
import { extensionOf, wavDurationMs } from './audio-format.js';

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
});
export type CaptureError = InferErrors<typeof CaptureError>;

/** A finished capture's audio. */
export type CapturedAudio = {
	readonly bytes: Uint8Array;
	/** The extension its bytes are saved under: `m4a` or `webm` from a browser. */
	readonly ext: string;
	readonly durationMs: number;
};

export type ActiveCapture = {
	/** `performance.now()` when capture began, for the elapsed-time display. */
	readonly startedAt: number;
	/** Hear capture end unexpectedly; stop still answers its audio. Retired by stop. */
	onEnded: RecordingHandle<unknown>['onEnded'];
	/**
	 * Release the microphone and answer the audio. Nothing is kept by this:
	 * a capture the page leaves without stopping ends with the page.
	 */
	stop(): Promise<Result<CapturedAudio, CaptureError>>;
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
	/** The microphone to record from. Undefined is the system default. */
	readonly input?: MicrophonePreference;
	/** Withdraws the start. A microphone that opens afterward is released. */
	readonly signal?: AbortSignal;
};

/** A capture device that answers the audio at Stop (a browser). */
export type CaptureDevice = {
	/** Where the audio is while it records: in the page, until Stop. */
	readonly keeps?: 'page';
	readonly source: CaptureSource;
	/** What the person is told this session records from. */
	readonly label: string;
	/** Undefined when this device has no real input to choose or test. */
	readonly inputs: MicrophoneInputs | undefined;
	start(options?: CaptureStart): Promise<Result<ActiveCapture, CaptureError>>;
};

/** A desktop start: the recording's id names its audio's path in the folder. */
export type FolderCaptureStart = CaptureStart & {
	/** The recording's id: the audio is written to `recordings/<id>.<ext>`. */
	readonly id: string;
};

/** A recording the shell is writing into the folder. */
export type FolderCapture = Omit<ActiveCapture, 'stop'> & {
	/**
	 * Finish the file and release the microphone. Answers how long it ran;
	 * the audio is already in the folder.
	 */
	stop(): Promise<Result<{ readonly durationMs: number }, CaptureError>>;
};

/**
 * A capture device that writes each recording into the folder from its
 * first sample (the desktop shell's).
 */
export type FolderCaptureDevice = {
	/** Where the audio is while it records: in the folder, from the start. */
	readonly keeps: 'folder';
	readonly source: CaptureSource;
	/** What the person is told this session records from. */
	readonly label: string;
	readonly inputs: MicrophoneInputs | undefined;
	/** The extension each recording's audio is written under: `wav`. */
	readonly ext: string;
	start(
		options: FolderCaptureStart,
	): Promise<Result<FolderCapture, CaptureError>>;
	/**
	 * Repair the audio of recordings a quit or a crash cut off, so each reads
	 * to its last sample. Answers the ids repaired.
	 */
	recover(): Promise<Result<string[], CaptureError>>;
};

/** Either way of capturing: the build's platform chooses one. */
export type AnyCaptureDevice = CaptureDevice | FolderCaptureDevice;

export type FixtureAudio = {
	readonly name: string;
	readonly bytes: Uint8Array;
};

/**
 * A device that answers every recording with the same fixture bytes, under
 * the fixture's own extension. `load` runs at stop, so a missing or
 * unreadable fixture fails that recording instead of the session.
 */
export function createFixtureDevice({
	name,
	load,
}: {
	name: string;
	load: () => Promise<FixtureAudio>;
}): CaptureDevice {
	const ext = extensionOf(name) || 'wav';
	return {
		source: 'fixture',
		label: `Fixture audio (${name})`,
		// No microphone is behind this device, so none is listed, asked for, or opened.
		inputs: undefined,
		async start() {
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
					return Ok({
						bytes: fixture.bytes,
						ext,
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
