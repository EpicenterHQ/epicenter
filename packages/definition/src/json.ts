export type JsonValue =
	| string
	| number
	| boolean
	| null
	| JsonValue[]
	| JsonObject;
export type JsonObject = { [key: string]: JsonValue };

/**
 * Whether a value is JSON: null, strings, booleans, finite numbers, arrays, and
 * plain objects of the same, with no cycle.
 *
 * This is the whole question and nothing else. It sets no limit on depth or
 * width, so it walks with its own stack instead of the call stack and answers
 * for a value nested a hundred thousand deep. A node reachable by two paths is
 * fine; only a node that contains itself is a cycle.
 */
export function isJsonSafe(value: unknown): value is JsonValue {
	if (value === null || typeof value === 'string' || typeof value === 'boolean')
		return true;
	if (typeof value === 'number') return Number.isFinite(value);
	if (typeof value !== 'object') return false;
	const ancestors = new Set<object>();
	// A node that passed once passes anywhere: it was walked whole, so no path
	// from it leads back to anything above it.
	const passed = new Set<object>();
	const open: { node: object; children: readonly unknown[]; next: number }[] =
		[];
	let current: unknown = value;
	for (;;) {
		if (typeof current === 'number') {
			if (!Number.isFinite(current)) return false;
		} else if (
			current !== null &&
			typeof current !== 'string' &&
			typeof current !== 'boolean'
		) {
			if (typeof current !== 'object' || ancestors.has(current)) return false;
			if (!passed.has(current)) {
				let children: readonly unknown[];
				if (Array.isArray(current)) children = current;
				else {
					const prototype = Object.getPrototypeOf(current);
					if (prototype !== Object.prototype && prototype !== null)
						return false;
					children = Object.values(current);
				}
				ancestors.add(current);
				open.push({ node: current, children, next: 0 });
			}
		}
		for (;;) {
			const frame = open.at(-1);
			if (frame === undefined) return true;
			if (frame.next < frame.children.length) {
				current = frame.children[frame.next++];
				break;
			}
			ancestors.delete(frame.node);
			passed.add(frame.node);
			open.pop();
		}
	}
}
