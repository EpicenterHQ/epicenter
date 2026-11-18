/**
 * Whispering runs in one place at a time, so the app is its folder's one
 * writer (ADR-0894). On the desktop the single-instance plugin focuses the
 * open window instead of starting a second, so this holds at once. In a
 * browser the open tab holds a Web Lock for as long as it runs; a second
 * tab waits for that lock, which it gets when the first tab closes. Nothing
 * steals the lock, so nothing interrupts a recording.
 */
import { isTauri } from '@tauri-apps/api/core';

const LOCK = 'so.epicenter.whispering';

/** Whether this tab may run Whispering now, or waits for another tab to close. */
export function holdOneTab(): { state(): 'held' | 'waiting' } {
	let state = $state<'held' | 'waiting'>('held');
	const locks = typeof navigator === 'undefined' ? undefined : navigator.locks;
	// The desktop has one window; a browser without Web Locks cannot tell.
	if (isTauri() || locks === undefined) return { state: () => state };
	state = 'waiting';
	/** Hold the lock for the page's life. */
	const forever = () => new Promise<void>(() => {});
	void locks
		.request(LOCK, { ifAvailable: true }, (lock) => {
			if (lock === null) return null;
			state = 'held';
			return forever();
		})
		.then((held) => {
			if (held !== null) return;
			// Another tab holds it: wait until it closes.
			void locks.request(LOCK, () => {
				state = 'held';
				return forever();
			});
		});
	return { state: () => state };
}
