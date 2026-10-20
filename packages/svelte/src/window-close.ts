/**
 * A desktop window's close, answered from the folder's current status: the one
 * close listener of the window a `FolderContext` guards
 * (`context.guardWindowClose()`).
 *
 * Tauri sends a close request to the page once a listener is registered,
 * and closes the window only if the page destroys it. Each request is
 * refused at once (`preventDefault`), so Tauri never destroys the window
 * itself. If a Folder save is pending, the person confirms whether to close
 * anyway. A request while one is answered is refused and answered by the
 * first. Destroying needs `core:window:allow-destroy`; a failed destroy keeps
 * the listener, so another close can be attempted.
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
let holding = false;

/** Let Epicenter ask this page whether its one mounted folder has pending saves. */
export async function reportFolderSaveStatus(
	pendingSave: () => boolean,
): Promise<() => void> {
	if (!isTauri() || globalThis.location?.protocol !== 'epicenter-app:')
		return () => {};
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

/** Tell the person why the window did what it did. */
async function notify(current: Window, title: string, description: string) {
	// A refused close can come from a background native tab. Select it so
	// the input and the explanation remain visible.
	try {
		await current.setFocus();
	} catch (cause) {
		log.error(
			new Error('The window could not show its unfinished input', { cause }),
		);
	}
	try {
		const { toast } = await import('@epicenter/ui/sonner');
		toast.warning(title, { description });
	} catch (cause) {
		log.error(new Error(`${title}: ${description}`, { cause }));
	}
}

/** Prompt only for accepted Folder work that has not saved. Answers the stop. */
export async function holdWindowClose(
	pendingSave: () => boolean,
	message: string,
): Promise<() => void> {
	if (!isTauri()) return () => {};
	if (holding) throw new Error('This window already has a Folder close guard');
	holding = true;
	let answering = false;
	let stopped = false;

	async function answer(current: Window) {
		if (answering || stopped) return;
		answering = true;
		try {
			if (pendingSave()) {
				await current.setFocus();
				const { confirm } = await import('@tauri-apps/plugin-dialog');
				if (stopped) return;
				// A fast save may finish while the dialog module loads.
				if (pendingSave()) {
					const confirmed = await confirm(message, {
						title: 'Close window?',
						kind: 'warning',
						okLabel: 'Close Anyway',
						cancelLabel: 'Cancel',
					});
					if (!confirmed) return;
				}
			}
			if (stopped) return;
			// A refused destroy restores the page.
			const page = globalThis.document?.documentElement;
			const wasInert = page?.inert;
			if (page) page.inert = true;
			try {
				await current.destroy();
			} catch (cause) {
				log.error(new Error('The window could not close itself', { cause }));
				await notify(
					current,
					'The window stayed open',
					'The window could not close. Try again.',
				);
			} finally {
				if (page) page.inert = wasInert ?? false;
			}
		} catch (cause) {
			log.error(new Error('The window could not confirm closing', { cause }));
		} finally {
			answering = false;
		}
	}

	try {
		const { getCurrentWindow } = await import('@tauri-apps/api/window');
		const current = getCurrentWindow();
		const unlisten = await current.onCloseRequested(async (event) => {
			event.preventDefault();
			await answer(current);
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
