/** Record each value `read` gives inside an effect, as a component would see it. */
export function track<T>(read: () => T) {
	const seen: T[] = [];
	const stop = $effect.root(() => {
		$effect(() => {
			seen.push(read());
		});
	});
	return { seen, stop };
}
