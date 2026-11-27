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
 * | `shortcuts` | keys that work from any app, held in Rust (`shortcuts.rs`) | none |
 * | `paste` | presses the paste keys in the app in front (`paste.rs`) | none |
 * | `media` | pauses music and video for a take (`media.rs`) | none |
 * | `pill` | a floating window over every app (`pill.rs`) | none |
 *
 * ```txt
 * settings.json
 * recordings/<id>.md      note: durationMs, then the transcript
 * recordings/<id>.webm    audio (.m4a from Safari)
 * ```
 */
import { isTauri } from '@tauri-apps/api/core';
import { writeText } from '@tauri-apps/plugin-clipboard-manager';
import { opfsFiles } from './files/opfs';
import { tauriFiles } from './files/tauri';
import { browserLocal } from './local/browser';
import { nativeLocal } from './local/native';
import { browserMedia } from './media/browser';
import { nativeMedia } from './media/native';
import { browserPaste } from './paste/browser';
import { nativePaste } from './paste/native';
import { browserPill } from './pill/browser';
import { nativePill } from './pill/native';
import { createBrowserRecorder } from './recorder/browser';
import { nativeRecorder } from './recorder/native';
import { createBrowserServers } from './servers/browser';
import { nativeServers } from './servers/native';
import { browserShortcuts } from './shortcuts/browser';
import { nativeShortcuts } from './shortcuts/native';

const desktop = isTauri();

export const files = desktop ? tauriFiles() : opfsFiles();
export const recorder = desktop ? nativeRecorder : createBrowserRecorder(files);
export const servers = desktop ? nativeServers : createBrowserServers(files);
export const local = desktop ? nativeLocal : browserLocal;
export const pill = desktop ? nativePill : browserPill;
export const media = desktop ? nativeMedia : browserMedia;
export const paste = desktop ? nativePaste : browserPaste;
export const shortcuts = desktop ? nativeShortcuts : browserShortcuts;
export const copyText = desktop
	? writeText
	: (text: string) => navigator.clipboard.writeText(text);
