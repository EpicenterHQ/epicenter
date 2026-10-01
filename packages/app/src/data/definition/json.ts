export type JsonValue =
	| string
	| number
	| boolean
	| null
	| JsonValue[]
	| JsonObject;
export type JsonObject = { [key: string]: JsonValue };

const JSON_DEPTH = 16;
const PROPERTIES_PER_OBJECT = 1_024;

function isJsonAtDepth(
	value: unknown,
	depth: number,
	ancestors: Set<object>,
): value is JsonValue {
	if (value === null || typeof value === 'string' || typeof value === 'boolean')
		return true;
	if (typeof value === 'number') return Number.isFinite(value);
	if (
		typeof value !== 'object' ||
		depth >= JSON_DEPTH ||
		ancestors.has(value)
	) {
		return false;
	}
	ancestors.add(value);
	const prototype = Object.getPrototypeOf(value);
	const isValid = Array.isArray(value)
		? value.every((child) => isJsonAtDepth(child, depth + 1, ancestors))
		: (prototype === Object.prototype || prototype === null) &&
			Object.keys(value).length <= PROPERTIES_PER_OBJECT &&
			Object.values(value).every((child) =>
				isJsonAtDepth(child, depth + 1, ancestors),
			);
	ancestors.delete(value);
	return isValid;
}

export function isJsonValue(value: unknown): value is JsonValue {
	return isJsonAtDepth(value, 0, new Set());
}

export function isJsonObject(value: unknown): value is JsonObject {
	return (
		typeof value === 'object' &&
		value !== null &&
		!Array.isArray(value) &&
		isJsonValue(value)
	);
}
