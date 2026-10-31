/**
 * `@epicenter/svelte/leave-guard`: leaving a page is unsure while a write is
 * out. A browser asks "Leave site?"; a desktop window waits for the writes,
 * then closes (closing again while it waits asks natively).
 *
 * Every write through `fromClient` and `fieldEdit` is held from
 * the moment it is asked for, so a keystroke counts before its save starts.
 * An app writing to a client directly (a capture of several files) hands
 * the write to `holdLeave` too. Each app root installs the guard once:
 *
 * @example
 * ```svelte
 * <script lang="ts">
 * 	import { guardLeave } from '@epicenter/svelte/leave-guard';
 * 	import { onMount } from 'svelte';
 *
 * 	onMount(guardLeave);
 * </script>
 * ```
 */
import { createLogger } from 'wellcrafted/logger';
import { holdWindowClose } from './window-close.js';

const log = createLogger('svelte/leave-guard');

/** Writes handed over and not yet settled, in this page. */
let out = 0;
/** Waiting for `out` to reach zero. */
let saved: PromiseWithResolvers<void> | null = null;

/** Count `write` as out until it settles, landed or refused; answers it as it is. */
export function holdLeave<T>(write: Promise<T>): Promise<T> {
	out++;
	return write.finally(() => {
		out--;
		if (out > 0 || saved === null) return;
		saved.resolve();
		saved = null;
	});
}

/** Whether a write is out in this page now. */
export const isSaving = () => out > 0;

/** Answers once no write is out (at once when none is). */
export function whenSaved(): Promise<void> {
	if (out === 0) return Promise.resolve();
	saved ??= Promise.withResolvers<void>();
	return saved.promise;
}

/**
 * Ask before the page is left while a write is out, and on desktop hold the
 * window's close until the writes settle. Answers the release.
 */
export function guardLeave(): () => void {
	const beforeUnload = (event: Event) => {
		if (isSaving()) event.preventDefault();
	};
	window.addEventListener('beforeunload', beforeUnload);
	let released = false;
	let releaseWindow: (() => void) | undefined;
	holdWindowClose(whenSaved).then(
		(release) => {
			if (released) release();
			else releaseWindow = release;
		},
		(cause: unknown) => {
			log.error(
				new Error('Closing this window will not wait for saves', { cause }),
			);
		},
	);
	return () => {
		if (released) return;
		released = true;
		window.removeEventListener('beforeunload', beforeUnload);
		releaseWindow?.();
	};
}
