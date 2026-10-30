/** Runtime schema values must preserve their meaning when copied to portable JSON. */
/** Inspect descriptors before stringify can invoke or drop runtime behavior. */
export function schemaSourceProblem(source: unknown): string | undefined {
	const active = new Set<object>();
	const visit = (value: unknown, path: string): string | undefined => {
		if (
			value === null ||
			typeof value === 'string' ||
			typeof value === 'boolean'
		)
			return undefined;
		if (typeof value === 'number')
			return Number.isFinite(value) && !Object.is(value, -0)
				? undefined
				: `${path} is not a portable JSON number`;
		if (typeof value !== 'object') return `${path} is not portable JSON`;
		if (active.has(value)) return `${path} refers back to itself`;
		const array = Array.isArray(value);
		const prototype = Object.getPrototypeOf(value);
		if (
			prototype !== (array ? Array.prototype : Object.prototype) &&
			prototype !== null
		)
			return `${path} is not a plain JSON object or array`;
		if (Object.getOwnPropertySymbols(value).length > 0)
			return `${path} has symbol keys`;
		if ('toJSON' in value) return `${path}.toJSON changes JSON serialization`;
		active.add(value);
		try {
			for (const key of Object.getOwnPropertyNames(value)) {
				if (array && key === 'length') continue;
				const descriptor = Object.getOwnPropertyDescriptor(value, key);
				const at = `${path}.${key}`;
				if (descriptor === undefined || !('value' in descriptor))
					return `${at} is an accessor`;
				if (!descriptor.enumerable) {
					if (key === '~kind' && typeof descriptor.value === 'string') continue;
					if (
						(key === '~optional' || key === '~readonly') &&
						descriptor.value === true
					)
						continue;
					return `${at} is hidden runtime behavior`;
				}
				if (array && !/^(0|[1-9][0-9]*)$/.test(key))
					return `${at} is not an array element`;
				const problem = visit(descriptor.value, at);
				if (problem !== undefined) return problem;
			}
			if (array && Object.keys(value).length !== (value as unknown[]).length)
				return `${path} is a sparse array`;
		} finally {
			active.delete(value);
		}
		return undefined;
	};
	return visit(source, 'tables');
}
