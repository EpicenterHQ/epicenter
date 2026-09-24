/**
 * Tauri-only capability namespace. Everything that requires the Tauri
 * runtime lives in this file: fs, permissions, window,
 * keyboard, autostart. The subset that needs TanStack caching,
 * error transformation, or invalidation is exposed in the same shape
 * (no sub-namespace), with each leaf picking one canonical call form.
 *
 * `#platform/tauri` selects this module under `epicenter-host`. The default
 * browser leaf exports `null`, so shared consumers check capability presence
 * without probing runtime globals.
 *
 * Two exports, one for each use case:
 *
 *     // Shared code, through the seam. `tauri` is annotated `Tauri | null`,
 *     // so consumers narrow before using the native capability.
 *     import { tauri } from '#platform/tauri';
 *     if (tauri) await tauri.fs.pathsToFiles(paths);
 *     // or
 *     await tauri?.fs.pathsToFiles(paths);
 *
 *     // Inside *.tauri.ts files, which import `tauriOnly` directly rather
 *     // than through the seam, since the seam does not export it:
 *     import { tauriOnly } from '$lib/tauri.tauri';
 *     await tauriOnly.fs.pathsToFiles(paths);
 *
 * The `: Tauri | null` annotation on a never-null value is deliberate. It
 * keeps shared call sites narrowing, which is what lets the dev browser tab
 * reach them without a `__TAURI_INTERNALS__` probe: the value IS the check.
 */

import { appDataDir, basename, extname, join } from '@tauri-apps/api/path';
import { getCurrentWebview } from '@tauri-apps/api/webview';
import { getCurrentWindow } from '@tauri-apps/api/window';
import { readFile } from '@tauri-apps/plugin-fs';
import { openPath as revealPath } from '@tauri-apps/plugin-opener';
import { defineErrors, extractErrorMessage } from 'wellcrafted/error';
import { createLogger } from 'wellcrafted/logger';
import {
	defineKeys,
	resultMutationOptions,
	resultQueryOptions,
} from 'wellcrafted/query';
import { Ok, tryAsync } from 'wellcrafted/result';
import type {
	DictationCapability,
	GlobalShortcutRegistration,
	MicrophonePermission,
} from './tauri/commands.js';
import { commands, events } from './tauri/commands.js';

const log = createLogger('whispering/tauri');

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

const fs = {
	pathsToFiles: (paths: string[]) =>
		tryAsync({
			try: () =>
				Promise.all(
					paths.map(async (path) => {
						// The File keeps filename evidence; blob-format owns interpretation.
						const bytes = (await readFile(path)) as Uint8Array<ArrayBuffer>;
						const fileName = await basename(path);
						return new File([bytes], fileName);
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

/**
 * Whether the OS microphone gate lets capture proceed.
 *
 * `granted` is the yes. `unknown` is also a yes: it means the platform has no
 * such gate or no readable consent entry, and a reading we cannot make must not
 * newly block a setup that was recording fine, so the recorder's stream-open
 * fallback stays the classifier of a real denial. `denied` and `not_determined`
 * are both no, and the difference between them is only what `request` can do
 * about it, which is Rust's business.
 */
function isMicrophoneUsable(status: MicrophonePermission): boolean {
	return status === 'granted' || status === 'unknown';
}

const permissions = {
	accessibility: {
		// Rust owns the platform dispatch (macOS raises the Accessibility prompt,
		// elsewhere a no-op), so the FE just calls the command. The prompt cannot
		// grant in place; the live grant is observed by the Rust tap supervisor,
		// so the Result here only reports whether the nudge fired.
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
		// Rust owns "what does the OS say about mic access" (macOS via
		// AVFoundation, Windows via the consent store, `unknown` elsewhere) and
		// answers both calls with the same four-state status. This adapter is
		// where that status stops: the app asks one question, "can I record", so
		// nothing above here has to know which OS state produced the answer.
		async check() {
			return tryAsync({
				try: async () =>
					isMicrophoneUsable(await commands.getMicrophonePermission()),
				catch: (error) => PermissionsError.CheckMicrophone({ cause: error }),
			});
		},

		// Ask once. macOS raises the system prompt when nobody has been asked yet
		// and waits for the user's answer; every other platform and every settled
		// status has nothing to elicit, so Rust returns the status that already
		// holds (Windows also opening its privacy page on the way). Either way the
		// returned status is the one in force after this call, so callers neither
		// pre-check nor re-check.
		async request() {
			const { data: status, error } =
				await commands.requestMicrophonePermission();
			if (error !== null) {
				return PermissionsError.RequestMicrophone({ cause: error });
			}
			return Ok(isMicrophoneUsable(status));
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
			// The command already returns a Result, so its error is mapped
			// straight across. This used to throw so an enclosing `tryAsync`
			// could catch it and build this same error, which is a round trip
			// through an exception to get back to where it started.
			queryFn: async () => {
				const { data, error } = await commands.isAutostartEnabled();
				if (error !== null) {
					return AutostartError.CheckFailed({ cause: new Error(error) });
				}
				return Ok(data);
			},
			// The OS login-item state can change outside the app (System Settings,
			// another tool, the platform dropping the entry), so re-read on focus
			// instead of trusting a stale cached value.
			refetchOnWindowFocus: true,
		}),
	},
	enable: {
		options: resultMutationOptions({
			mutationKey: autostartKeys.enable,
			mutationFn: async () => {
				const { error } = await commands.setAutostartEnabled(true);
				if (error !== null) {
					return AutostartError.EnableFailed({ cause: new Error(error) });
				}
				return Ok(undefined);
			},
		}),
	},
	disable: {
		options: resultMutationOptions({
			mutationKey: autostartKeys.disable,
			mutationFn: async () => {
				const { error } = await commands.setAutostartEnabled(false);
				if (error !== null) {
					return AutostartError.DisableFailed({ cause: new Error(error) });
				}
				return Ok(undefined);
			},
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
// Transcription, not model administration: Whispering asks the host to
// transcribe on whichever model is active, and reads advisory readiness so it
// can warn before capture. Choosing, downloading, and deleting models, and even
// learning which model is active, belong to Epicenter Home (ADR-0180); no
// Whispering window is granted those commands.
//
// These are raw Tauri shapes and are internal on purpose. ADR-0181 replaces
// them with one portable `epicenter` handle whose members are the same in every
// runtime: this namespace becomes `epicenter.transcription`
// (`capabilities()` / `transcribe()` / `prewarm()`) and the navigation below
// becomes `epicenter.shell.openHome('transcription')`. Nothing here claims to
// be that handle. What this wave does establish is the substrate it will wrap:
// the host-side contract, and the two behaviours the SDK shape depends on, kept
// here so the next wave moves them rather than redesigns them.
const transcription = {
	encodeRecordingForUpload: commands.encodeRecordingForUpload,
	getLocalTranscriptionReadiness: commands.getLocalTranscriptionReadiness,
	transcribeRecording: commands.transcribeRecording,

	/**
	 * A timing hint that transcription may be imminent. Synchronous and
	 * outcome-free by contract (ADR-0181): this namespace owns the asynchronous
	 * best-effort work and its diagnostics, so callers cannot forget to handle a
	 * rejection and never branch on whether warming worked. A real problem
	 * surfaces at transcribe with a message the user can act on.
	 */
	prewarmModel: (): void => {
		void commands.prewarmModel().then(
			(result) => {
				if (result.error !== null) {
					log.info('Prewarming the local model did not run', {
						error: result.error,
					});
				}
			},
			(cause) => {
				log.info('Prewarming the local model could not be requested', {
					cause,
				});
			},
		);
	},

	/**
	 * Ask the shell to open Home's transcription section. Fire-and-forget for
	 * the same reason: the outcome a caller cares about is the user arriving,
	 * which is not something this promise reports.
	 */
	openHomeTranscription: (): void => {
		void commands.openHome('transcription').catch((cause) => {
			log.info('Opening Epicenter Home was refused', { cause });
		});
	},
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

const mainWindow = {
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
 * The Tauri capability namespace, widened to `Tauri | null` so shared code has
 * to narrow before calling it. Doubles as the platform check.
 */
export const tauri: Tauri | null = tauriOnly;
