/**
 * Tauri-only capability namespace. Everything that requires the Tauri
 * runtime lives in this file: fs, permissions, window,
 * keyboard, autostart. The subset that needs TanStack caching,
 * error transformation, or invalidation is exposed in the same shape
 * (no sub-namespace), with each leaf picking one canonical call form.
 *
 * Two files, one import path (`#platform/tauri`, declared in package.json
 * "imports"):
 *
 *     this file                              -> Tauri build (`tauri` condition)
 *     `./tauri.browser.ts` (exports `null`)  -> web build (`default`)
 *
 * Both files annotate the export `: Tauri | null` and export the `Tauri`
 * type, so consumers always see the full shape regardless of which one
 * resolves.
 *
 * Two patterns, one for each use case:
 *
 *     import { tauri } from '#platform/tauri';
 *     if (tauri) await tauri.fs.pathsToFiles(paths);
 *     // or
 *     await tauri?.fs.pathsToFiles(paths);
 *
 *     // Inside *.tauri.ts files only (build guarantees Tauri runtime).
 *     // `tauriOnly` is imported directly, not through the `#platform/tauri`
 *     // seam, which resolves to `null` on web and does not export it:
 *     import { tauriOnly } from '$lib/tauri.tauri';
 *     await tauriOnly.fs.pathsToFiles(paths);
 *
 * `tauri` doubles as the platform check: truthy means we're on Tauri
 * and the whole namespace is available. There is no separate
 * `__TAURI_INTERNALS__` check; the value IS the check.
 *
 * Why the `: Tauri | null` annotation on a never-null local: it widens the
 * export type so consumers are forced to narrow.
 *
 * See `specs/20260526T000140-collapse-tauri-only-services-into-namespace.md`.
 */

import { Channel } from '@tauri-apps/api/core';
import { appDataDir, basename, extname, join } from '@tauri-apps/api/path';
import { getCurrentWebview } from '@tauri-apps/api/webview';
import { getCurrentWindow } from '@tauri-apps/api/window';
import { readFile } from '@tauri-apps/plugin-fs';
import { openPath as revealPath } from '@tauri-apps/plugin-opener';
import mime from 'mime';
import { defineErrors, extractErrorMessage } from 'wellcrafted/error';
import {
	defineKeys,
	resultMutationOptions,
	resultQueryOptions,
} from 'wellcrafted/query';
import { Ok, tryAsync } from 'wellcrafted/result';
import type {
	DictationCapability,
	DownloadProgress,
	GlobalShortcutRegistration,
} from '$lib/tauri/commands';
import { commands, events } from '$lib/tauri/commands';

/**
 * A global chord resolved to the accelerator the plugin registers under. The
 * caller (`platform/system-shortcuts.tauri.ts`) computes each accelerator once,
 * so `registerChords` registers the string instead of re-deriving it.
 */
export type ChordRegistration = GlobalShortcutRegistration;

// fs ----------------------------------------------------------------
const FsError = defineErrors({
	ReadFilesFailed: ({ paths, cause }: { paths: string[]; cause: unknown }) => ({
		message: `Failed to read files: ${paths.join(', ')}: ${extractErrorMessage(cause)}`,
		paths,
		cause,
	}),
});

async function readFileWithMimeType(path: string): Promise<{
	bytes: Uint8Array<ArrayBuffer>;
	mimeType: string;
}> {
	// Cast is safe: Tauri's readFile always returns ArrayBuffer-backed Uint8Array.
	const bytes = (await readFile(path)) as Uint8Array<ArrayBuffer>;
	const mimeType = mime.getType(path) ?? 'application/octet-stream';
	return { bytes, mimeType };
}

const fs = {
	pathsToFiles: (paths: string[]) =>
		tryAsync({
			try: () =>
				Promise.all(
					paths.map(async (path) => {
						const { bytes, mimeType } = await readFileWithMimeType(path);
						const fileName = await basename(path);
						return new File([bytes], fileName, { type: mimeType });
					}),
				),
			catch: (error) => FsError.ReadFilesFailed({ paths, cause: error }),
		}),
	appDataPath: async (...segments: string[]) =>
		join(await appDataDir(), ...segments),
	extension: extname,
	onDragDrop: (handler: (paths: string[]) => void | Promise<void>) =>
		getCurrentWebview().onDragDropEvent(async (event) => {
			if (event.payload.type !== 'drop' || event.payload.paths.length === 0)
				return;
			await handler(event.payload.paths);
		}),
};

// permissions -------------------------------------------------------
const PermissionsError = defineErrors({
	RequestAccessibility: ({ cause }: { cause: unknown }) => ({
		message: `Failed to request accessibility permissions: ${extractErrorMessage(cause)}`,
		cause,
	}),
	OpenAccessibilitySettings: ({ cause }: { cause: unknown }) => ({
		message: `Failed to open accessibility settings: ${extractErrorMessage(cause)}`,
		cause,
	}),
	CheckMicrophone: ({ cause }: { cause: unknown }) => ({
		message: `Failed to check microphone permissions: ${extractErrorMessage(cause)}`,
		cause,
	}),
	RequestMicrophone: ({ cause }: { cause: unknown }) => ({
		message: `Failed to request microphone permissions: ${extractErrorMessage(cause)}`,
		cause,
	}),
});

const permissions = {
	accessibility: {
		// Rust owns the platform dispatch (macOS prompts via the permissions
		// plugin, elsewhere a no-op), so the FE just calls the command. The prompt
		// cannot grant in place; the live grant is observed by the Rust tap
		// supervisor, so the Result here only reports whether the nudge fired.
		async request() {
			return tryAsync({
				try: () => commands.requestAccessibilityPermission(),
				catch: (error) =>
					PermissionsError.RequestAccessibility({ cause: error }),
			});
		},

		async openSettings() {
			const { error } = await commands.openAccessibilitySettings();
			if (error !== null) {
				return PermissionsError.OpenAccessibilitySettings({ cause: error });
			}
			return Ok(undefined);
		},
	},

	microphone: {
		// One transport for every platform: Rust owns "what does the OS say about
		// mic access" (macOS via the permissions plugin, Windows via the consent
		// store, `unknown` elsewhere). Only an explicit `denied` gates; `granted`
		// and `unknown` both read as available, so a missing consent entry never
		// newly blocks a setup that was recording fine, and the recorder's
		// stream-open fallback still classifies any real denial.
		async check() {
			return tryAsync({
				try: async () =>
					(await commands.getMicrophonePermission()) !== 'denied',
				catch: (error) => PermissionsError.CheckMicrophone({ cause: error }),
			});
		},

		// Elicit a grant the way the platform allows (macOS prompt, Windows privacy
		// page when denied); the caller re-checks afterward. No platform can grant
		// in place, so this only reports whether the nudge itself succeeded.
		async request() {
			const { error } = await commands.requestMicrophonePermission();
			if (error !== null) {
				return PermissionsError.RequestMicrophone({ cause: error });
			}
			return Ok(undefined);
		},
	},
};

// keyboard ----------------------------------------------------------
// Global-shortcut input is `tauri-plugin-global-shortcut` chords owned by Rust.
// This adapter replaces the configured set through one focused command and
// dispatches Rust's typed Pressed/Released event into `dispatchCommandTrigger`;
// no Accessibility grant is needed (ADR-0117). The rest of this namespace is the macOS
// paste-at-cursor grant watch: `setAutoPasteEnabled` tells the Rust supervisor
// when auto-paste wants the grant, and `getDictationCapability` /
// `onDictationCapabilityChanged` expose the `DictationCapability` the paste path
// gates on.

// autostart ---------------------------------------------------------
const AutostartError = defineErrors({
	CheckFailed: ({ cause }: { cause: unknown }) => ({
		message: `Failed to check autostart: ${extractErrorMessage(cause)}`,
		cause,
	}),
	EnableFailed: ({ cause }: { cause: unknown }) => ({
		message: `Failed to enable autostart: ${extractErrorMessage(cause)}`,
		cause,
	}),
	DisableFailed: ({ cause }: { cause: unknown }) => ({
		message: `Failed to disable autostart: ${extractErrorMessage(cause)}`,
		cause,
	}),
});

// Public namespaces ------------------------------------------------
// Each capability picks ONE shape per method: TanStack where reactivity,
// caching, or invalidation is the point; plain Result functions otherwise.
// One canonical call shape per leaf; no duplicate capability/query namespace.
// duplication.

const autostartKeys = defineKeys({
	isEnabled: ['autostart', 'isEnabled'],
	enable: ['autostart', 'enable'],
	disable: ['autostart', 'disable'],
});

const autostart = {
	isEnabled: {
		options: resultQueryOptions({
			queryKey: autostartKeys.isEnabled,
			queryFn: () =>
				tryAsync({
					try: async () => {
						const { data, error } = await commands.isAutostartEnabled();
						if (error !== null) throw new Error(error);
						return data;
					},
					catch: (error) => AutostartError.CheckFailed({ cause: error }),
				}),
			// The OS login-item state can change outside the app (System Settings,
			// another tool, the platform dropping the entry), so re-read on focus
			// instead of trusting a stale cached value.
			refetchOnWindowFocus: true,
		}),
	},
	enable: {
		options: resultMutationOptions({
			mutationKey: autostartKeys.enable,
			mutationFn: () =>
				tryAsync({
					try: async () => {
						const { error } = await commands.setAutostartEnabled(true);
						if (error !== null) throw new Error(error);
					},
					catch: (error) => AutostartError.EnableFailed({ cause: error }),
				}),
		}),
	},
	disable: {
		options: resultMutationOptions({
			mutationKey: autostartKeys.disable,
			mutationFn: () =>
				tryAsync({
					try: async () => {
						const { error } = await commands.setAutostartEnabled(false);
						if (error !== null) throw new Error(error);
					},
					catch: (error) => AutostartError.DisableFailed({ cause: error }),
				}),
		}),
	},
};

let shortcutListenerPromise: ReturnType<
	typeof events.globalShortcutTriggered.listen
> | null = null;
/** The latest registration's dispatcher; chord events always hit the current app. */
let onShortcutTriggered:
	| ((commandId: string, state: 'Pressed' | 'Released') => void)
	| null = null;

const keyboard = {
	/**
	 * Replace the Rust-owned chord set and subscribe once to its typed trigger
	 * event. Rust owns plugin registration and rollback; this adapter dispatches
	 * Pressed/Released into the command layer (the convergence point the browser
	 * backend also feeds). A binding with no accelerator (Fn or modifier-only) is
	 * refused upstream, so nothing reaches here but chords. Carbon's
	 * `RegisterEventHotKey` needs no Accessibility grant.
	 */
	registerChords: async (
		chords: GlobalShortcutRegistration[],
		onTrigger: (commandId: string, state: 'Pressed' | 'Released') => void,
	) => {
		onShortcutTriggered = onTrigger;
		if (!shortcutListenerPromise) {
			shortcutListenerPromise = events.globalShortcutTriggered.listen(
				({ payload }) => {
					onShortcutTriggered?.(payload.commandId, payload.state);
				},
			);
		}
		await shortcutListenerPromise;
		const { error } = await commands.replaceGlobalShortcuts(chords);
		if (error !== null) throw new Error(error);
	},

	/** Unregister every plugin-registered chord (teardown). */
	unregisterChords: async () => {
		const { error } = await commands.replaceGlobalShortcuts([]);
		if (error !== null) throw new Error(error);
	},

	/**
	 * Tell the tap supervisor whether auto-paste-at-cursor is on. Paste writes
	 * through the macOS Accessibility grant the tap watches, so when it is on the
	 * supervisor holds the tap to track that grant (and surface the notice if it
	 * is missing). It is the only reason the tap runs. Pushed on startup and on
	 * every output-settings change.
	 */
	setAutoPasteEnabled: (enabled: boolean) =>
		commands.setAutoPasteEnabled(enabled),

	/**
	 * The current paste capability, for the FE's seed on attach. The Rust
	 * supervisor owns the tap's lifecycle and trust gating, so there is no
	 * `start`: the tap is already running whenever the capability is `active`.
	 */
	getDictationCapability: (): Promise<DictationCapability> =>
		commands.getDictationCapability(),

	/**
	 * Subscribe to dictation-capability changes pushed by the Rust supervisor
	 * (trust gained or lost, tap died, stale grant detected). Returns the
	 * unlisten fn. The supervisor owns the meaning, so the FE just renders the
	 * value instead of inferring liveness or re-probing the OS.
	 */
	onDictationCapabilityChanged: (
		onChange: (capability: DictationCapability) => void,
	) =>
		events.dictationCapabilityEvent.listen(({ payload }) =>
			onChange(payload.capability),
		),
};

// media -------------------------------------------------------------
const media = {
	pause: () => commands.pausePlayback(),
	resume: (sessions: string[]) => commands.resumePlayback(sessions),
};

// transcription ----------------------------------------------------
// Shared transcription orchestration uses this namespace through the
// `#platform/tauri` seam. Keeping the raw generated bindings here prevents a
// browser build from retaining native invoke names merely because it shares the
// orchestration module with Epicenter.
const transcription = {
	encodeRecordingForUpload: commands.encodeRecordingForUpload,
	listModels: commands.listModels,
	downloadModel: (
		modelId: string,
		downloadId: string,
		onProgress: (progress: DownloadProgress) => void,
	) => {
		const channel = new Channel<DownloadProgress>();
		channel.onmessage = onProgress;
		return commands.downloadModel(modelId, downloadId, channel);
	},
	deleteModel: commands.deleteModel,
	cancelDownload: commands.cancelDownload,
	prewarmModel: commands.prewarmModel,
	transcribeRecording: commands.transcribeRecording,
	setUnloadPolicy: commands.setUnloadPolicy,
};

// opener ------------------------------------------------------------
const OpenerError = defineErrors({
	OpenPathFailed: ({ path, cause }: { path: string; cause: unknown }) => ({
		message: `Failed to open ${path}: ${extractErrorMessage(cause)}`,
		path,
		cause,
	}),
});

const opener = {
	/** Reveal a file or folder in the OS file manager (Finder, Explorer). */
	openPath: (path: string) =>
		tryAsync({
			try: () => revealPath(path),
			catch: (cause) => OpenerError.OpenPathFailed({ path, cause }),
		}),
};

/**
 * The app's main window. `focus()` raises and focuses it, used when a global
 * shortcut needs to surface in-app UI (the recipe picker) over whatever the user
 * is currently in. A stopgap until the picker becomes its own floating window.
 */
const mainWindow = {
	async focus(): Promise<void> {
		const window = getCurrentWindow();
		await window.show();
		await window.setFocus();
	},
	async reveal(): Promise<void> {
		const window = getCurrentWindow();
		await window.show();
		await window.unminimize();
		// Raising the window can succeed even when macOS refuses the focus request.
		await window.setFocus().catch(() => {});
	},
};

// barrel ------------------------------------------------------------
// `tauriOnly` is the non-null namespace for `.tauri.ts` files. The
// `tauri` export widens it to `Tauri | null` so shared consumers narrow.
export const tauriOnly = {
	fs,
	permissions,
	keyboard,
	autostart,
	media,
	transcription,
	opener,
	mainWindow,
};

/** Shape of the Tauri capability namespace (non-null). */
export type Tauri = typeof tauriOnly;

/**
 * The Tauri capability namespace, or `null` on web builds.
 * Doubles as the platform check: truthy means Tauri.
 */
export const tauri: Tauri | null = tauriOnly;
