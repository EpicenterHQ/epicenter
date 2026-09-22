import { defineErrors, type InferErrors } from 'wellcrafted/error';
import { Ok, type Result } from 'wellcrafted/result';
import type {
	JsonObject,
	JsonValue,
} from '../definition/index.js';

export const FileContractError = defineErrors({
	InvalidChanges: ({
		fields,
	}: {
		fields: {
			field: string;
			reason: 'not-permitted';
		}[];
	}) => ({
		message: 'The submission contains fields that cannot be changed',
		fields,
	}),
});
export type FileContractError = InferErrors<typeof FileContractError>;

/** Compare JSON values, ignoring object key order but preserving array order. */
export function sameFieldValue(
	left: JsonValue | undefined,
	right: JsonValue | undefined,
): boolean {
	if (left == null || right == null) return left === right;
	if (left === right) return true;
	if (typeof left !== 'object' || typeof right !== 'object') return false;
	if (Array.isArray(left) || Array.isArray(right)) {
		return (
			Array.isArray(left) &&
			Array.isArray(right) &&
			left.length === right.length &&
			left.every((value, index) => sameFieldValue(value, right[index]))
		);
	}
	const keys = Object.keys(left);
	return (
		keys.length === Object.keys(right).length &&
		keys.every(
			(key) =>
				Object.hasOwn(right, key) && sameFieldValue(left[key], right[key]),
		)
	);
}

/** A sparse patch inferred from file edits, never from the current store values. */
export function fieldChanges(
	permitted: readonly string[],
	base: JsonObject,
	file: JsonObject,
): Result<JsonObject, FileContractError> {
	const patch: JsonObject = Object.create(null);
	const failures: {
		field: string;
		reason: 'not-permitted';
	}[] = [];
	for (const name of new Set([...Object.keys(base), ...Object.keys(file)])) {
		const before = Object.hasOwn(base, name) ? base[name] : undefined;
		const after = Object.hasOwn(file, name) ? file[name] : undefined;
		if (sameFieldValue(before ?? null, after ?? null)) continue;
		const value = after ?? null;
		if (!permitted.includes(name))
			failures.push({ field: name, reason: 'not-permitted' });
		else patch[name] = value;
	}
	return failures.length
		? FileContractError.InvalidChanges({ fields: failures })
		: Ok(patch);
}

/** KV omission deletes a key; explicit null remains a stored value. */
export function kvChanges(
	permitted: readonly string[],
	base: JsonObject,
	file: JsonObject,
): Result<{ set: JsonObject; delete: string[] }, FileContractError> {
	const set: JsonObject = Object.create(null);
	const removed: string[] = [];
	const failures: { field: string; reason: 'not-permitted' }[] = [];
	for (const name of new Set([...Object.keys(base), ...Object.keys(file)])) {
		const before = Object.hasOwn(base, name) ? base[name] : undefined;
		const after = Object.hasOwn(file, name) ? file[name] : undefined;
		if (sameFieldValue(before, after)) continue;
		if (!permitted.includes(name)) {
			failures.push({ field: name, reason: 'not-permitted' });
			continue;
		}
		if (after === undefined) removed.push(name);
		else set[name] = after;
	}
	return failures.length
		? FileContractError.InvalidChanges({ fields: failures })
		: Ok({ set, delete: removed });
}
