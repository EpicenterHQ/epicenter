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
		log.error(
			new Error('The window could not receive focus', { cause }),
		);
	}
}

/** Explain a failed close while keeping the window available to retry. */
async function notifyCloseFailure(current: Window, guard: symbol) {
	await focusWindow(current);
	try {
		const { toast } = await import('@epicenter/ui/sonner');
		if (activeGuard !== guard) return;
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
 * Answer this window's close after its drafts and Folder writes finish.
 * Successful destruction stays occupied and inert until the page is gone:
 * Tauri's destroy promise acknowledges dispatch, not completed destruction.
 */
export async function holdWindowClose(
	/** Work to finish before the window is destroyed, such as saves in flight. */
	beforeDestroy?: () => Promise<void>,
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
		const unlisten = await current.onCloseRequested(async (event) => {
			event.preventDefault();
			if (closing || activeGuard !== guard) return;
			closing = true;
			const page = document.documentElement;
			const wasInert = page.inert;
			try {
				if (activeGuard !== guard) return;
				page.inert = true;
				await beforeDestroy?.();
				if (activeGuard !== guard) return;
				await current.destroy();
			} catch (cause) {
				if (activeGuard !== guard) return;
				page.inert = wasInert;
				log.error(new Error('The window could not close', { cause }));
				await notifyCloseFailure(current, guard);
				closing = false;
				return;
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
