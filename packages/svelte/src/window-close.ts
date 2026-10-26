/**
 * Hold a desktop window's close until the page's writes land.
 *
 * A Tauri window, unlike a browser tab, can wait: the first close request
 * waits for queued writes, then destroys the window. The
 * page shows "Saving…" meanwhile. Closing again while it waits asks whether to
 * close anyway, so a save that never answers cannot trap the window. One guard
 * owns a window, because Tauri runs each close listener on its own.
 * Application Quit remains owned by the shell.
 */
import { isTauri } from '@tauri-apps/api/core';
import { createLogger } from 'wellcrafted/logger';

const log = createLogger('svelte/window-close');
// Tauri runs each close listener on its own, so a window holds one at a time.
let held = false;

async function askToClose() {
	const { ask } = await import('@tauri-apps/plugin-dialog');
	return ask('Some changes are still saving. Close the window anyway?', {
		kind: 'warning',
		okLabel: 'Close anyway',
		cancelLabel: 'Keep waiting',
	});
}

/**
 * Close this window once `drain` reports the page's writes landed; closing
 * again while it waits asks whether to close anyway. A window already held
 * answers a release that does nothing. Successful destruction stays occupied
 * and inert until the page is gone: Tauri's destroy promise acknowledges
 * dispatch, not completed destruction.
 */
export async function holdWindowClose(
	drain: () => Promise<void> = async () => {},
): Promise<() => void> {
	if (!isTauri() || held) return () => {};
	held = true;
	let phase: 'open' | 'waiting' | 'gone' = 'open';
	let asking = false;
	let wasInert = false;

	try {
		const { getCurrentWindow } = await import('@tauri-apps/api/window');
		const current = getCurrentWindow();

		async function destroy() {
			if (phase === 'gone') return;
			phase = 'gone';
			try {
				await current.destroy();
			} catch (cause) {
				log.error(new Error('The window could not close', { cause }));
				document.documentElement.inert = wasInert;
				phase = 'open';
			}
		}

		const unlisten = await current.onCloseRequested(async (event) => {
			event.preventDefault();
			if (phase === 'gone') return;
			if (phase === 'waiting') {
				if (asking) return;
				asking = true;
				try {
					if (await askToClose()) await destroy();
				} finally {
					asking = false;
				}
				return;
			}
			phase = 'waiting';
			wasInert = document.documentElement.inert;
			document.documentElement.inert = true;
			try {
				await drain();
			} catch (cause) {
				log.error(
					new Error('The window could not wait for its writes', { cause }),
				);
			}
			if (phase === 'waiting') await destroy();
		});
		let holding = true;
		return () => {
			if (!holding) return;
			holding = false;
			held = false;
			unlisten();
		};
	} catch (cause) {
		held = false;
		throw cause;
	}
}
