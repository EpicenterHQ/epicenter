/**
 * Reads a value in an effect, as a mounted component reads it, so the
 * lists a test checks are followed as the pages follow them. Load this
 * module with a dynamic `import()` after `svelte-dom.test-support.js`.
 */

/** Run `read` in an effect and record each value until `stop`. */
export function follow<T>(read: () => T) {
	const values: T[] = [];
	const stop = $effect.root(() => {
		$effect(() => {
			values.push(read());
		});
	});
	return { values, stop };
}

/**
 * Make `make`'s value inside an effect root, as a component's script makes
 * what it observes (`createQuery`, `useMutationState`), until `stop`.
 */
export function rooted<T>(make: () => T) {
	let value!: T;
	const stop = $effect.root(() => {
		value = make();
	});
	return { value, stop };
}
