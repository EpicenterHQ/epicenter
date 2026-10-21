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
 * unfinished saves. Native destruction ends a recording and keeps its audio;
 * a recording adds no close warning. Application Quit stays in `shell.rs`.
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
import { isTauri } from '@tauri-apps/api/core';
import type { Window } from '@tauri-apps/api/window';
import { createLogger } from 'wellcrafted/logger';

const log = createLogger('svelte/window-close');
// One owner records both registration and whether an older listener is retired.
let activeGuard: symbol | undefined;

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
 * Answer this window's close from its unfinished Folder saves.
 * Successful destruction stays occupied and inert until the page is gone:
 * Tauri's destroy promise acknowledges dispatch, not completed destruction.
 */
export async function holdWindowClose(
	pendingSave: () => boolean,
): Promise<() => void> {
	if (!isTauri()) return () => {};
	if (activeGuard) throw new Error('This window already has a Folder close guard');
	const guard = Symbol('window close');
	activeGuard = guard;
	let closing = false;

	try {
		const { getCurrentWindow } = await import('@tauri-apps/api/window');
		const current = getCurrentWindow();
		const unlisten = await current.onCloseRequested(async (event) => {
			event.preventDefault();
			if (closing || activeGuard !== guard) return;
			closing = true;
			const page = globalThis.document?.documentElement;
			const wasInert = page?.inert ?? false;
			try {
				if (pendingSave()) {
					await focusWindow(current);
					const { confirm } = await import('@tauri-apps/plugin-dialog');
					if (activeGuard !== guard) return;
					const confirmed = await confirm(
						'A change has not saved yet. Close anyway?',
						{
							title: 'Close window?',
							kind: 'warning',
							okLabel: 'Close Anyway',
							cancelLabel: 'Cancel',
						},
					);
					if (!confirmed) {
						closing = false;
						return;
					}
				}
				if (activeGuard !== guard) return;
				if (page) page.inert = true;
				await current.destroy();
			} catch (cause) {
				if (activeGuard !== guard) return;
				if (page) page.inert = wasInert;
				log.error(new Error('The window could not close', { cause }));
				await notifyCloseFailure(current);
				closing = false;
			}
		});
		return () => {
			if (activeGuard !== guard) return;
			activeGuard = undefined;
			unlisten();
		};
	} catch (cause) {
		activeGuard = undefined;
		throw cause;
	}
}
