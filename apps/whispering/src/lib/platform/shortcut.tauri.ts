/**
 * The global shortcut (`src-tauri/src/shortcut.rs`), as the desktop window
 * hears it: the shell holds the key while Whispering runs and sends each
 * press; the page decides what it does. Hardcoded for now.
 */
import { listen } from '@tauri-apps/api/event';

/** The shortcut, as the shell registers it (`CommandOrControl+Shift+Semicolon`). */
export const SHORTCUT_LABEL = navigator.userAgent.includes('Mac')
	? '⌘⇧;'
	: 'Ctrl+Shift+;';

/** Hear each press of the global shortcut. Answers the unsubscribe. */
export function onShortcut(listener: () => void): () => void {
	let stop: (() => void) | undefined;
	let stopped = false;
	void listen('whispering://toggle-recording', listener).then((unlisten) => {
		if (stopped) unlisten();
		else stop = unlisten;
	});
	return () => {
		stopped = true;
		stop?.();
	};
}
