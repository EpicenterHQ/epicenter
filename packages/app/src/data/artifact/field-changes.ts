import { recognize } from '@epicenter/matter-core/field';
import { defineErrors, type InferErrors } from 'wellcrafted/error';
import { Ok, type Result } from 'wellcrafted/result';
import type {
	JsonObject,
	JsonValue,
	ParsedTable,
} from '../definition/index.js';

export const FileContractError = defineErrors({
	UnsupportedField: ({ table, field }: { table: string; field: string }) => ({
		message: `Field '${table}.${field}' cannot be represented by Matter`,
		table,
		field,
	}),
	InvalidChanges: ({
		fields,
	}: {
		fields: {
			field: string;
			reason: 'undeclared' | 'not-permitted' | 'invalid-value';
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
	if (left == null || right == null) return left == null && right == null;
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
	table: ParsedTable,
	permitted: readonly string[],
	base: JsonObject,
	file: JsonObject,
): Result<JsonObject, FileContractError> {
	const patch: JsonObject = Object.create(null);
	const failures: {
		field: string;
		reason: 'undeclared' | 'not-permitted' | 'invalid-value';
	}[] = [];
	for (const name of new Set([...Object.keys(base), ...Object.keys(file)])) {
		const before = Object.hasOwn(base, name) ? base[name] : undefined;
		const after = Object.hasOwn(file, name) ? file[name] : undefined;
		if (sameFieldValue(before, after)) continue;
		const field = table.fields.get(name);
		const value = after ?? null;
		if (!field) failures.push({ field: name, reason: 'undeclared' });
		else if (!permitted.includes(name))
			failures.push({ field: name, reason: 'not-permitted' });
		else if (!(value === null ? field.nullable : field.check(value)))
			failures.push({ field: name, reason: 'invalid-value' });
		else patch[name] = value;
	}
	return failures.length
		? FileContractError.InvalidChanges({ fields: failures })
		: Ok(patch);
}

/** Export only schemas recognized with the same kind by both applications. */
export function matterContract(
	table: ParsedTable,
): Result<
	{ fields: Record<string, unknown>; optional: string[] },
	FileContractError
> {
	const fields: Record<string, unknown> = Object.create(null);
	const optional: string[] = [];
	const columns = new Set(['body', 'stem', '_extra']);
	for (const field of table.fields.values()) {
		if (
			columns.has(field.name.toLowerCase()) ||
			recognize(field.valueSchema)?.kind !== field.kind
		)
			return FileContractError.UnsupportedField({
				table: table.name,
				field: field.name,
			});
		columns.add(field.name.toLowerCase());
		fields[field.name] = field.valueSchema;
		if (field.nullable) optional.push(field.name);
	}
	return Ok({ fields, optional });
}
