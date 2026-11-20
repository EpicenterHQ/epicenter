/**
 * Everything that differs between the desktop app and a browser, chosen
 * once. The rest of the page imports these and never asks where it runs.
 *
 * | | Desktop app | Browser |
 * | --- | --- | --- |
 * | `files` | the app's local data directory | the Origin Private File System |
 * | `recorder` | the native recorder, writing each second | `MediaRecorder`, writing on Stop |
 * | `servers` | Rust sends each request; keys are in the Keychain | `fetch` sends it; keys are in `localStorage` |
 * | `copyText` | the clipboard plugin, which works while another app is in front | the page's clipboard |
 * | `onShortcut` | ⌘⇧; from any app, held in Rust (`main.rs`), with the app in front | none |
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
import { createBrowserRecorder } from './recorder/browser';
import { nativeRecorder } from './recorder/native';
import { createBrowserServers } from './servers/browser';
import { nativeServers } from './servers/native';

const desktop = isTauri();

export const files = desktop ? tauriFiles() : opfsFiles();
export const recorder = desktop ? nativeRecorder : createBrowserRecorder(files);
export const servers = desktop ? nativeServers : createBrowserServers(files);
export const copyText = desktop
	? writeText
	: (text: string) => navigator.clipboard.writeText(text);

/** An app on the computer, as `front_app.rs` names it. */
export type FrontApp = { bundleId: string; name: string };

/**
 * Call `run` on each press of the global shortcut until the returned
 * function is called, with the app that was in front when it was pressed:
 * the app the person is dictating into. It is undefined when Whispering
 * itself was in front or the system could not say.
 *
 * Rust holds the shortcut and sends each press here; a browser has no
 * global shortcut, so it never calls `run`.
 */
export function onShortcut(
	run: (app: FrontApp | undefined) => void,
): () => void {
	if (!desktop) return () => {};
	const listening = listen<FrontApp | null>('toggle-recording', (event) =>
		run(event.payload ?? undefined),
	);
	return () => void listening.then((stop) => stop());
}
