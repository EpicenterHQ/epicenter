/**
 * Hold a desktop window's close until the page is sure it may leave.
 *
 * A browser asks a page's `beforeunload` listeners before a tab goes, and
 * shows "Leave site?" when one prevents it. A Tauri window asks nothing: it
 * destroys the webview. This guard asks the same listeners, waits for the
 * writes they started, asks them again, and shows one native question only
 * when the page is still unsure. One guard owns a window, because Tauri runs
 * each close listener on its own. Application Quit remains owned by the shell.
 */
import { isTauri } from '@tauri-apps/api/core';
import { createLogger } from 'wellcrafted/logger';

const log = createLogger('svelte/window-close');
/** How long a close waits for writes before asking; a hung save cannot trap the window. */
const DRAIN_MS = 3000;
// Tauri runs each close listener on its own, so a window holds one at a time.
let held = false;

/** Ask the page's `beforeunload` listeners, as a browser would before leaving. */
function unsure() {
	const event = new Event('beforeunload', { cancelable: true });
	window.dispatchEvent(event);
	return event.defaultPrevented;
}

const elapsed = (ms: number) =>
	new Promise<void>((resolve) => setTimeout(resolve, ms));

async function askToClose() {
	const { ask } = await import('@tauri-apps/plugin-dialog');
	return ask('Some changes did not save. Close the window anyway?', {
		kind: 'warning',
		okLabel: 'Close',
		cancelLabel: 'Keep open',
	});
}

/**
 * Answer this window's close once `drain` reports the page's writes landed,
 * asking first if the page is still unsure. A window already held answers a
 * release that does nothing. Successful destruction stays occupied and inert
 * until the page is gone: Tauri's destroy promise acknowledges dispatch, not
 * completed destruction.
 */
export async function holdWindowClose(
	drain: () => Promise<void> = async () => {},
): Promise<() => void> {
	if (!isTauri() || held) return () => {};
	held = true;
	let closing = false;

	try {
		const { getCurrentWindow } = await import('@tauri-apps/api/window');
		const current = getCurrentWindow();
		const unlisten = await current.onCloseRequested(async (event) => {
			event.preventDefault();
			if (closing) return;
			closing = true;
			const page = document.documentElement;
			const wasInert = page.inert;
			const stay = () => {
				page.inert = wasInert;
				closing = false;
			};
			try {
				page.inert = true;
				unsure(); // Drafts send what was typed.
				await Promise.race([drain(), elapsed(DRAIN_MS)]);
				if (unsure() && !(await askToClose())) return stay();
				await current.destroy();
			} catch (cause) {
				log.error(new Error('The window could not close', { cause }));
				stay();
			}
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
