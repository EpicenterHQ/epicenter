/**
 * A desktop window's close, answered from the folder's current status: the one
 * close listener of the window a `FolderContext` guards
 * (`context.guardWindowClose()`).
 *
 * Tauri sends a close request to the page once a listener is registered,
 * and closes the window only if the page destroys it. Each request is
 * refused at once (`preventDefault`), so Tauri never destroys the window
 * itself.
 *
 * Each page answers its own close with one awaited native confirmation for
 * unfinished saves or a recording. Epicenter supplies only the recording
 * fact, from its native recorder; application Quit stays in `shell.rs`.
 * Repeated requests for this window join its current answer. Other windows
 * answer independently. Destroying needs `core:window:allow-destroy`; a failed
 * destroy keeps the listener and restores input so another close can be tried.
 * Save status is sampled once per request; a save finishing while the prompt
 * opens does not withdraw the question.
 *
 * Outside the desktop app nothing listens, and the browser's unload
 * behavior stands. Tauri's window API loads only inside the desktop app,
 * and the notice's toast only when one is shown, so a store that imports
 * the folder context loads neither.
 */
import { invoke, isTauri } from '@tauri-apps/api/core';
import type { Window } from '@tauri-apps/api/window';
import { createLogger } from 'wellcrafted/logger';

const log = createLogger('svelte/window-close');
let holding = false;

/**
 * Whether Epicenter serves this page and supplies recording status and Quit:
 * its `epicenter-app` scheme, which Tauri serves as
 * `epicenter-app://localhost` on macOS and Linux and as
 * `http(s)://epicenter-app.localhost` on Windows and Android.
 */
function inEpicenter() {
	const location = globalThis.location;
	if (location === undefined) return false;
	if (location.protocol === 'epicenter-app:')
		return location.hostname === 'localhost';
	return (
		(location.protocol === 'http:' || location.protocol === 'https:') &&
		location.hostname === 'epicenter-app.localhost'
	);
}

/** Let Epicenter ask this page whether its one mounted folder has pending saves. */
export async function reportFolderSaveStatus(
	pendingSave: () => boolean,
): Promise<() => void> {
	if (!isTauri() || !inEpicenter()) return () => {};
	const [{ emit, listen }, { getCurrentWindow }] = await Promise.all([
		import('@tauri-apps/api/event'),
		import('@tauri-apps/api/window'),
	]);
	const label = getCurrentWindow().label;
	return listen<number>(
		'epicenter://quit-check',
		({ payload }) => {
			void emit('epicenter://quit-status', {
				id: payload,
				label,
				pending: pendingSave(),
			}).catch((cause: unknown) =>
				log.error(
					new Error('Could not report the folder save status', { cause }),
				),
			);
		},
		{ target: { kind: 'WebviewWindow', label } },
	);
}

/** Select a background native tab without making focus a condition of closing. */
async function focusWindow(current: Window) {
	try {
		await current.setFocus();
	} catch (cause) {
		log.error(
			new Error('The window could not show its unfinished input', { cause }),
		);
	}
}

/** Explain a failed close while keeping the window available to retry. */
async function notifyCloseFailure(current: Window) {
	await focusWindow(current);
	try {
		const { toast } = await import('@epicenter/ui/sonner');
		toast.warning('The window stayed open', {
			description: 'The window could not close. Try again.',
		});
	} catch (cause) {
		log.error(
			new Error('Could not show the window-close failure notice', { cause }),
		);
	}
}

/**
 * Answer this window's close from its unfinished Folder saves and recording.
 * Successful destruction stays occupied and inert until the page is gone:
 * Tauri's destroy promise acknowledges dispatch, not completed destruction.
 */
export async function holdWindowClose(
	pendingSave: () => boolean,
): Promise<() => void> {
	if (!isTauri()) return () => {};
	if (holding) throw new Error('This window already has a Folder close guard');
	holding = true;
	let closing = false;
	let stopped = false;

	try {
		const { getCurrentWindow } = await import('@tauri-apps/api/window');
		const current = getCurrentWindow();
		const unlisten = await current.onCloseRequested(async (event) => {
			event.preventDefault();
			if (closing || stopped) return;
			closing = true;
			const page = globalThis.document?.documentElement;
			const wasInert = page?.inert ?? false;
			try {
				const recording = inEpicenter()
					? await invoke<boolean>('window_is_recording')
					: false;
				if (stopped) return;
				const unsaved = pendingSave();
				if (unsaved || recording) {
					await focusWindow(current);
					const { confirm } = await import('@tauri-apps/plugin-dialog');
					if (stopped) return;
					const message = recording
						? unsaved
							? 'This window is recording, and a change has not saved yet. Closing it ends the recording and keeps the audio captured so far.'
							: 'This window is recording. Closing it ends the recording and keeps the audio captured so far.'
						: 'A change has not saved yet. Close anyway?';
					const confirmed = await confirm(message, {
						title: 'Close window?',
						kind: 'warning',
						okLabel: 'Close Anyway',
						cancelLabel: 'Cancel',
					});
					if (!confirmed) {
						closing = false;
						return;
					}
				}
				if (stopped) return;
				if (page) page.inert = true;
				await current.destroy();
			} catch (cause) {
				if (page) page.inert = wasInert;
				log.error(new Error('The window could not close', { cause }));
				await notifyCloseFailure(current);
				closing = false;
			}
		});
		return () => {
			if (stopped) return;
			stopped = true;
			holding = false;
			unlisten();
		};
	} catch (cause) {
		holding = false;
		throw cause;
	}
}
