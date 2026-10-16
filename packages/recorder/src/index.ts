/**
 * `@epicenter/recorder`: recordings written into a folder, microphone
 * streams, device vocabulary, and voice activity detection.
 *
 * `startRecording` and `recoverRecordings` decide where the page runs when
 * they are called, not when this module is imported, and load only the
 * implementation they chose: the desktop shell's recorder inside a desktop
 * app, `MediaRecorder` in a browser tab. To build for one environment, import
 * `@epicenter/recorder/tauri` or `@epicenter/recorder/browser`. Only the
 * desktop entry lists inputs and reads a level through the shell
 * (`listInputs`, `openMeter`); a desktop page opens no microphone of its own.
 *
 * The streams and voice activity detection here are the browser's: they call
 * `getUserMedia`, so a desktop build must not import this entry.
 */
import { isTauri } from '@tauri-apps/api/core';
import type { RecoverRecordings, StartRecording } from './recording.js';

export {
	cleanupRecordingStream,
	DeviceStreamError,
	getRecordingStream,
} from './device-stream';
export {
	asDeviceIdentifier,
	type DeviceAcquisitionOutcome,
	type DeviceIdentifier,
} from './devices';
export * from './recording.js';
export {
	createVadRecorder,
	type StartActiveListeningOptions,
	type VadRecorder,
	type VadRecorderError,
} from './vad-recorder';

/**
 * Start recording into the folder: `<path>.wav`, written from the first
 * sample, inside a desktop app; `<path>.<extension>`, written on stop, in a
 * browser. A desktop page never falls back to the browser's recorder.
 */
export const startRecording: StartRecording = async (options) =>
	isTauri()
		? (await import('./tauri.js')).startRecording(options)
		: (await import('./browser.js')).startRecording(options);

/**
 * Repair the recordings under a directory that a quit or a crash cut off.
 * Idempotent; a browser has none to repair.
 */
export const recoverRecordings: RecoverRecordings = async (options) =>
	isTauri()
		? (await import('./tauri.js')).recoverRecordings(options)
		: (await import('./browser.js')).recoverRecordings(options);
