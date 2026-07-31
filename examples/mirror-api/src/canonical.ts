/**
 * Deterministic serialization for mirror declarations.
 *
 * Object keys sort, array order is preserved, and anything that cannot be
 * compared byte-for-byte across runs (functions, `undefined`, symbols,
 * non-finite numbers) is refused rather than silently dropped. `JSON.stringify`
 * is unusable here because it preserves insertion order, which would make
 * reordering a declaration a rebuild.
 */

export function canonicalJson(value: unknown): string {
	if (value === null) return 'null';

	switch (typeof value) {
		case 'string':
			return JSON.stringify(value);
		case 'boolean':
			return value ? 'true' : 'false';
		case 'number':
			if (!Number.isFinite(value)) {
				throw new TypeError(
					'A mirror declaration cannot contain a non-finite number',
				);
			}
			return JSON.stringify(value);
		case 'object': {
			if (Array.isArray(value)) {
				return `[${value.map(canonicalJson).join(',')}]`;
			}
			const record = value as Record<string, unknown>;
			return `{${Object.keys(record)
				.sort()
				.map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`)
				.join(',')}}`;
		}
		default:
			throw new TypeError(
				`A mirror declaration cannot contain a ${typeof value} value`,
			);
	}
}
