/**
 * `#platform/computer` in Whispering's desktop window: what this computer
 * offers through the shell, which `src/lib/app.ts` makes its capabilities
 * with.
 *
 * - The microphone is the shell's (`@epicenter/recorder/tauri`, ADR-0571),
 *   which writes each recording into the data folder from its first sample,
 *   as Opus in WebM placed at `recordings/<id>.webm` when it stops; a quit,
 *   a crash, or a closed window keeps the audio up to about its last
 *   second, which recovery finishes and places on the next launch.
 * - Ollama and LM Studio on this computer are reached through the shell's
 *   fetch with no key (`shellFetch`), since neither answers a `tauri://`
 *   page.
 * - The global shortcut is held by the shell (`openShortcut`).
 *
 * Transcription on this computer (`localSpeech` from
 * `@epicenter/transcription`) and the connections the person saved
 * (`customEndpoints`, kept in AppData with each key in the credential
 * store, sent through the shell) are picked by their own packages' builds.
 */
import { localServers } from '@epicenter/ai';
import { shellFetch } from '@epicenter/ai/tauri';
import type { Recorder } from '@epicenter/recorder';
import { recorder } from '@epicenter/recorder/tauri';

export { openShortcut } from './shortcut.tauri.js';

/** What records from the microphone in this build. */
export const microphone: Recorder = recorder;

/** The model servers on this computer, as this build reaches them. */
export const localModelServers = () => localServers({ fetch: shellFetch });
