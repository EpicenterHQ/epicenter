/**
 * `@epicenter/svelte/leave-guard`: leaving a page is unsure while a write is
 * out, so a browser asks "Leave site?" (online, a write can take a while to
 * land). Closing a desktop window does not ask the page: the window closes at
 * once, and a local write still out then is a small, rare loss at the edge
 * (ADR-0702's test for every protection).
 *
 * Every write through `fromClient`, and every keystroke in a note's `edit`,
 * is held from the moment it is asked for, so a keystroke counts before its
 * save starts.
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

/** Ask before the page is left while a write is out. Answers the release. */
export function guardLeave(): () => void {
	const beforeUnload = (event: Event) => {
		if (isSaving()) event.preventDefault();
	};
	window.addEventListener('beforeunload', beforeUnload);
	return () => window.removeEventListener('beforeunload', beforeUnload);
}
