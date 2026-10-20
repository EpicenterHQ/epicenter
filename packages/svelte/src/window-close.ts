/**
 * A desktop window's close, held until the page says it may go: the one
 * close listener of the window a `FolderContext` guards
 * (`context.guardWindowClose()`).
 *
 * Tauri sends a close request to the page once a listener is registered,
 * and closes the window only if the page destroys it. Each request is
 * refused at once (`preventDefault`), so Tauri never destroys the window
 * itself; `blockers` then answers. No reason: the page destroys the window.
 * Reasons: the window stays with everything typed in it, is brought forward, and a notice says
 * why. A request while one is answered is refused and answered by the
 * first. Destroying needs `core:window:allow-destroy`; a failed destroy keeps
 * the listener, so another close must pass the same save check.
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

/** Hold each close of this window until `blockers` answers none. Answers the stop. */
export async function holdWindowClose(
	blockers: () => Promise<readonly string[]>,
): Promise<() => void> {
	if (!isTauri()) return () => {};
	if (holding) throw new Error('This window already has a Folder close guard');
	holding = true;
	let answering = false;
	let stopped = false;
	const listening = import('@tauri-apps/api/window').then(
		({ getCurrentWindow }) => {
			const current = getCurrentWindow();
			return current.onCloseRequested(async (event) => {
				event.preventDefault();
				await answer(current);
			});
		},
	);

	async function answer(current: Window) {
		if (answering || stopped) return;
		answering = true;
		try {
			let reasons: readonly string[];
			try {
				reasons = await blockers();
			} catch (cause) {
				log.error(
					new Error('The window could not check its typing', { cause }),
				);
				reasons = ['Whether everything typed is saved could not be checked.'];
			}
			if (stopped) return;
			if (reasons.length > 0) {
				await notify(current, 'The window stayed open', reasons.join(' '));
				return;
			}
			// Once the save check succeeds, no new typing may arrive while the
			// shell is destroying the window. A refused destroy restores the page.
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
		} finally {
			answering = false;
		}
	}

	let unlisten: () => void;
	try {
		unlisten = await listening;
	} catch (cause) {
		holding = false;
		throw cause;
	}
	function stop() {
		if (stopped) return;
		stopped = true;
		holding = false;
		unlisten();
	}
	return stop;
}
