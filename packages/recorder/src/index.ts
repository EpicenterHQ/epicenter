/**
 * `@epicenter/recorder`: the recording vocabulary (`recording.ts`), and
 * `recorder`, this window's microphones, chosen when this module loads
 * with `isTauri()` (ADR-0781). In a Tauri window it is the shell's, whose
 * code (`tauri.ts`) loads with the first call; in a browser it is the
 * page's own (`browser.ts`).
 */
import { isTauri } from '@tauri-apps/api/core';
import { recorder as pageRecorder } from './browser.js';
import type { Recorder } from './recording.js';

export * from './recording.js';

/** The shell's recorder, its code loaded with the first call. */
const shell = () => import('./tauri.js').then((module) => module.recorder);
const shellRecorder: Recorder = {
	start: async (options) => (await shell()).start(options),
	recover: async (options) => (await shell()).recover(options),
	listInputs: async () => (await shell()).listInputs(),
	openMeter: async (options) => (await shell()).openMeter(options),
};

/** What records from this window's microphones. */
export const recorder: Recorder = isTauri() ? shellRecorder : pageRecorder;
