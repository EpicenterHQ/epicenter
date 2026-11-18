import { Err, Ok, type Result } from 'wellcrafted/result';
import type { JsonValue } from './front-matter.ts';

export type PublicError = { name: string; message: string };

function plain(value: unknown): value is Record<string, unknown> {
	if (value === null || typeof value !== 'object') return false;
	const prototype = Object.getPrototypeOf(value);
	return prototype === Object.prototype || prototype === null;
}

/** Every action returns one Result. Its app owns the success data and extra error fields. */
export function isActionResult(
	value: unknown,
): value is Result<unknown, PublicError> {
	if (
		!plain(value) ||
		Reflect.ownKeys(value).length !== 2 ||
		!Object.hasOwn(value, 'error') ||
		!Object.hasOwn(value, 'data')
	)
		return false;
	const error = value.error;
	if (error === null) return true;
	return (
		value.data === null &&
		plain(error) &&
		typeof error.name === 'string' &&
		typeof error.message === 'string'
	);
}

/** Copy an action answer to JSON once, rejecting fields JSON would silently corrupt. */
export function encodeActionResult(
	result: Result<unknown, PublicError>,
): Result<JsonValue, PublicError> {
	const parents = new Set<object>();
	function encode(value: unknown): JsonValue {
		if (value === null || value === undefined) return null;
		if (typeof value === 'string' || typeof value === 'boolean') return value;
		if (typeof value === 'number' && Number.isFinite(value)) return value;
		if ((!Array.isArray(value) && !plain(value)) || parents.has(value))
			throw new TypeError('An action answer must contain only JSON values');
		parents.add(value);
		try {
			if (Array.isArray(value)) return Array.from(value, encode);
			return Object.fromEntries(
				Object.entries(value)
					.filter(([, field]) => field !== undefined)
					.map(([key, field]) => [key, encode(field)]),
			);
		} finally {
			parents.delete(value);
		}
	}
	if (result.error === null) return Ok(encode(result.data));
	const error = encode(result.error);
	if (
		!plain(error) ||
		typeof error.name !== 'string' ||
		typeof error.message !== 'string'
	)
		throw new TypeError('Invalid encoded action error');
	return Err({ ...error, name: error.name, message: error.message });
}
