export function canonicalJson(value: unknown): string {
	if (
		value === null ||
		typeof value === 'string' ||
		typeof value === 'boolean'
	) {
		return JSON.stringify(value);
	}
	if (typeof value === 'number' && Number.isFinite(value))
		return JSON.stringify(value);
	if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
	if (typeof value === 'object') {
		// Function and `undefined` values are dropped, as `JSON.stringify` drops
		// them: a table's file codec (ADR-0296) rides beside its data, and the
		// canonical form is the inert data core alone (ADR-0266).
		return `{${Object.entries(value)
			.filter(([, child]) => typeof child !== 'function' && child !== undefined)
			.sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
			.map(([key, child]) => `${JSON.stringify(key)}:${canonicalJson(child)}`)
			.join(',')}}`;
	}
	throw new TypeError('Canonical JSON accepts only finite JSON values');
}
