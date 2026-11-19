/**
 * What an action returns, checked where it crosses into JSON. An answer is
 * exactly `{ data, error }`, where `error` is `null` or an object with a
 * `name` and a `message`; serve copies it to JSON once, refusing what JSON
 * would silently change.
 */
import { Err, Ok, type Result } from 'wellcrafted/result';
import type { PublicError } from './errors.ts';
import type { JsonValue } from './front-matter.ts';

/** An action's answer on every surface: what it returned, or the error itself. */
export type Answer = Result<unknown, PublicError>;

/** Whether `value` is an object made by `{}` or `Object.create(null)`. */
export function isPlainObject(
	value: unknown,
): value is Record<string, unknown> {
	if (value === null || typeof value !== 'object') return false;
	const prototype = Object.getPrototypeOf(value);
	return prototype === Object.prototype || prototype === null;
}

/** Whether `value` is an answer: `{ data, error }` and nothing else. */
export function isAnswer(value: unknown): value is Answer {
	if (
		!isPlainObject(value) ||
		Reflect.ownKeys(value).length !== 2 ||
		!Object.hasOwn(value, 'error') ||
		!Object.hasOwn(value, 'data')
	)
		return false;
	const { error } = value;
	if (error === null) return true;
	return (
		value.data === null &&
		isPlainObject(error) &&
		typeof error.name === 'string' &&
		typeof error.message === 'string'
	);
}

/**
 * `answer` copied to JSON values. `undefined` becomes `null`, a property
 * that is `undefined` is dropped, and anything else JSON would change, such
 * as a `Date`, a `Map`, `NaN` or a cycle, throws.
 */
export function toJsonAnswer(answer: Answer): Result<JsonValue, PublicError> {
	const parents = new Set<object>();
	function encode(value: unknown): JsonValue {
		if (value === null || value === undefined) return null;
		if (typeof value === 'string' || typeof value === 'boolean') return value;
		if (typeof value === 'number' && Number.isFinite(value)) return value;
		if ((!Array.isArray(value) && !isPlainObject(value)) || parents.has(value))
			throw new TypeError('An action answer must contain only JSON values');
		parents.add(value);
		try {
			if (Array.isArray(value)) return Array.from(value, encode);
			return Object.fromEntries(
				Object.entries(value)
					.filter(([, item]) => item !== undefined)
					.map(([key, item]) => [key, encode(item)]),
			);
		} finally {
			parents.delete(value);
		}
	}
	if (answer.error === null) return Ok(encode(answer.data));
	const error = encode(answer.error) as Record<string, JsonValue>;
	return Err({
		...error,
		name: answer.error.name,
		message: answer.error.message,
	});
}
