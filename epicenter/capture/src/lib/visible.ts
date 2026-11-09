import { untrack } from 'svelte';

/**
 * Runs `ask` now, again whenever the page becomes visible, and every
 * `every` milliseconds while it stays visible, so what an agent wrote
 * elsewhere appears without a reload. Returns the function that stops it,
 * which suits an `$effect`; what `refresh` reads is not tracked, so the
 * effect does not start over when it changes.
 */
export function whileVisible(ask: () => void, every = 15_000): () => void {
	const refresh = () => untrack(ask);
	let timer: ReturnType<typeof setInterval> | undefined;
	const start = () => {
		timer ??= setInterval(refresh, every);
	};
	const stop = () => {
		clearInterval(timer);
		timer = undefined;
	};
	const onChange = () => {
		if (document.visibilityState !== 'visible') return stop();
		refresh();
		start();
	};
	refresh();
	if (document.visibilityState === 'visible') start();
	document.addEventListener('visibilitychange', onChange);
	return () => {
		stop();
		document.removeEventListener('visibilitychange', onChange);
	};
}
