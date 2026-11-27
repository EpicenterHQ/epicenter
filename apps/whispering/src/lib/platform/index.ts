/**
 * Everything that differs between the desktop app and a browser, chosen
 * once. The rest of the page imports these and never asks where it runs.
 *
 * | | Desktop app | Browser |
 * | --- | --- | --- |
 * | `files` | the app's local data directory | the Origin Private File System |
 * | `recorder` | the native recorder, writing each second; hands-free | `MediaRecorder`, writing on Stop; no hands-free |
 * | `servers` | Rust sends each request; keys are in the Keychain | `fetch` sends it; keys are in `localStorage` |
 * | `local` | models on this computer, run by transcribe.cpp (`local.rs`) | none |
 * | `copyText` | the clipboard plugin, which works while another app is in front | the page's clipboard |
 * | `onShortcut` | ⌘⇧; from any app, held in Rust (`main.rs`) | none |
 * | `pill` | a floating window over every app (`pill.rs`) | none |
 *
 * ```txt
 * settings.json
 * recordings/<id>.md      note: durationMs, then the transcript
 * recordings/<id>.webm    audio (.m4a from Safari)
 * ```
 */
import { isTauri } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';
import { writeText } from '@tauri-apps/plugin-clipboard-manager';
import { opfsFiles } from './files/opfs';
import { tauriFiles } from './files/tauri';
import { browserLocal } from './local/browser';
import { nativeLocal } from './local/native';
import { browserPill } from './pill/browser';
import { nativePill } from './pill/native';
import { createBrowserRecorder } from './recorder/browser';
import { nativeRecorder } from './recorder/native';
import { createBrowserServers } from './servers/browser';
import { nativeServers } from './servers/native';

const desktop = isTauri();

export const files = desktop ? tauriFiles() : opfsFiles();
export const recorder = desktop ? nativeRecorder : createBrowserRecorder(files);
export const servers = desktop ? nativeServers : createBrowserServers(files);
export const local = desktop ? nativeLocal : browserLocal;
export const pill = desktop ? nativePill : browserPill;
export const copyText = desktop
	? writeText
	: (text: string) => navigator.clipboard.writeText(text);

/**
 * Call `run` on each press of the global shortcut until the returned
 * function is called. Rust holds the shortcut and sends each press here; a
 * browser has no global shortcut, so it never calls `run`.
 */
export function onShortcut(run: () => void): () => void {
	if (!desktop) return () => {};
	const listening = listen('toggle-recording', run);
	return () => void listening.then((stop) => stop());
}
