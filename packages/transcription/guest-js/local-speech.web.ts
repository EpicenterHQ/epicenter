/**
 * `localSpeech()` off the desktop: there is no transcribe.cpp in a browser,
 * so it is null, and the same `openAi([... , localSpeech()])` skips it. The
 * build picks this leaf by default and `local-speech.ts` under the `tauri`
 * condition.
 */
import type { LocalSpeech } from './local-speech.js';

export type { LocalSpeech };

/** This app's in-process speech endpoint: none in a browser. */
export function localSpeech(): LocalSpeech | null {
	return null;
}
