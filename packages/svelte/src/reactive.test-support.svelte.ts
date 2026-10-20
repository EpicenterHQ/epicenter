/**
 * Runes for tests of reactive bindings. Load this module with a dynamic
 * `import()` after `svelte-modules.test-support.js`, and call `flushSync`
 * before reading what an effect recorded.
 */

/** Runs `read` in an effect, as a component reading it would, and records each value until `stop`. */
export function follow<T>(read: () => T) {
	const values: T[] = [];
	const stop = $effect.root(() => {
		$effect(() => {
			values.push(read());
		});
	});
	return { values, stop };
}

/** A reactive value, as a component's `$state` or a query's data is. */
export function cell<T>(initial: T) {
	let value = $state.raw(initial);
	return {
		get value() {
			return value;
		},
		set value(next: T) {
			value = next;
		},
	};
}
