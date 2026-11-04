/**
 * `#platform/computer` in the web build: what this computer offers a
 * browser tab, which `src/lib/app.ts` makes its capabilities with. The
 * desktop window's is `computer.tauri.ts`.
 *
 * - The microphone is the page's own (`@epicenter/recorder/browser`), which
 *   appends each piece of a recording to this browser's files as it
 *   arrives.
 * - Ollama and LM Studio on this computer are looked for through the tab's
 *   own `fetch`, and are found only when they allow this origin.
 * - The web has no global shortcut.
 */
import { localServers } from '@epicenter/ai';
import type { Folder } from '@epicenter/folder/core';
import type { Recorder } from '@epicenter/recorder';
import { recorder } from '@epicenter/recorder/browser';
import type { Whispering } from '../contract.js';
import type { GlobalShortcut } from './types.js';

/** What records from the microphone in this build. */
export const microphone: Recorder = recorder;

/** The model servers on this computer, as this build reaches them. */
export const localModelServers = () => localServers();

/** The global shortcut: none on the web. */
export const openShortcut = (
	_folder: Pick<Folder<Whispering>, 'shortcuts'>,
): GlobalShortcut | null => null;
