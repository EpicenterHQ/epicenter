/**
 * Hold a desktop window's close while mounted drafts flush and folder writes
 * drain. Each close request is prevented until the page destroys the window.
 * Application Quit remains owned by the shell.
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
		log.error(new Error('The window could not receive focus', { cause }));
	}
}

/** Explain why the window stayed open, offering a close action when there is one. */
async function notifyKeptOpen(
	current: Window,
	guard: symbol,
	description: string,
	closeAnyway?: () => void,
) {
	await focusWindow(current);
	try {
		const { toast } = await import('@epicenter/ui/sonner');
		if (activeGuard !== guard) return;
		toast.warning('The window stayed open', {
			description,
			...(closeAnyway && {
				action: { label: 'Close anyway', onClick: closeAnyway },
			}),
		});
	} catch (cause) {
		log.error(new Error('Could not show the window-close notice', { cause }));
	}
}

/**
 * Answer this window's close after its drafts and Folder writes finish.
 * `beforeDestroy` may answer why the window should stay open, such as typed
 * text that did not save; the notice then offers to close anyway.
 * Successful destruction stays occupied and inert until the page is gone:
 * Tauri's destroy promise acknowledges dispatch, not completed destruction.
 */
export async function holdWindowClose(
	/** Work to finish before the window is destroyed, answering a reason to stay open. */
	beforeDestroy?: () => Promise<string | void>,
): Promise<() => void> {
	if (!isTauri()) return () => {};
	if (activeGuard)
		throw new Error('This window already has a Folder close guard');
	const guard = Symbol('window close');
	activeGuard = guard;
	let closing = false;

	try {
		const { getCurrentWindow } = await import('@tauri-apps/api/window');
		const current = getCurrentWindow();

		/** Close for this guard; `confirm` answers a reason to stay open instead. */
		async function close(confirm?: () => Promise<string | void>) {
			if (closing || activeGuard !== guard) return;
			closing = true;
			const page = document.documentElement;
			const wasInert = page.inert;
			try {
				page.inert = true;
				const reason = await confirm?.();
				if (activeGuard !== guard) {
					page.inert = wasInert;
					return;
				}
				if (typeof reason === 'string') {
					page.inert = wasInert;
					closing = false;
					await notifyKeptOpen(current, guard, reason, () => void close());
					return;
				}
				await current.destroy();
			} catch (cause) {
				if (activeGuard !== guard) return;
				page.inert = wasInert;
				log.error(new Error('The window could not close', { cause }));
				await notifyKeptOpen(
					current,
					guard,
					'The window could not close. Try again.',
				);
				closing = false;
			}
		}

		const unlisten = await current.onCloseRequested(async (event) => {
			event.preventDefault();
			await close(beforeDestroy);
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
