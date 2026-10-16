/**
 * Test helper: what a mounted Svelte view shows of some state.
 *
 * A component's template is a set of effects over the values it reads. This
 * runs one real `$effect` under `$effect.root`, with Svelte's client runtime,
 * over `read`, and records each value it shows. An effect reruns only when a
 * signal it read changed, so a value that changes without notifying anyone
 * stays stale here exactly as it would on screen.
 *
 * Load this module with a dynamic `import()` after
 * `packages/svelte/src/svelte-modules.test-support.js`, like any runes module.
 */
export function showing<T>(read: () => T) {
	const shown: T[] = [];
	const stop = $effect.root(() => {
		$effect(() => {
			shown.push(read());
		});
	});
	return {
		/** Every value shown so far, in order. */
		shown,
		/** What is on screen now, once pending effects have run. */
		async current(): Promise<T | undefined> {
			// Effects run in a microtask after the change that scheduled them.
			await Bun.sleep(0);
			return shown.at(-1);
		},
		stop,
	};
}
