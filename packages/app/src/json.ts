/**
 * JSON values as every surface carries them. It uses only web APIs, so a
 * UI's bundle can carry it.
 */

/** A JSON value. */
export type JsonValue =
	| string
	| number
	| boolean
	| null
	| JsonValue[]
	| { [key: string]: JsonValue };

/** `text` as JSON, or undefined when it is not JSON. */
export function parseJson(text: string) {
	try {
		return JSON.parse(text) as JsonValue;
	} catch {
		return undefined;
	}
}

/** Whether `value` is an object made by `{}` or `Object.create(null)`. */
export function isPlainObject(
	value: unknown,
): value is Record<string, unknown> {
	if (value === null || typeof value !== 'object') return false;
	const prototype = Object.getPrototypeOf(value);
	return prototype === Object.prototype || prototype === null;
}
