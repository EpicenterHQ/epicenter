import type { TSchema } from 'typebox';
import { Value } from 'typebox/value';
import { Ok, type Result } from 'wellcrafted/result';
import { isActionResult } from './action-result.ts';
import { folder } from './context.ts';
import { ActionError } from './errors.ts';
import { absentValue } from './field.ts';
import {
	type FieldValues,
	type JsonValue,
	markdownOf,
	readMarkdown,
	withFields,
} from './front-matter.ts';
import {
	type Fields,
	isOptional,
	misfit,
	projectFields,
} from './markdown-fields.ts';

type Misfit = Extract<ActionError, { name: 'Misfit' }>;
export type CallbackError = { name: string; message: string };
export type AnyRecord = Record<string, unknown> & {
	path: string;
	body: string;
};
export type Write = { fields: Record<string, unknown>; body?: unknown };
type Need = 'absent' | 'present' | 'either';
type Found = ReturnType<typeof readMarkdown>;

/** `values` in the order the collection declares its fields, then the rest. */
function inDeclaredOrder(values: FieldValues, fields: Fields): FieldValues {
	const order = Object.keys(fields);
	const rank = (key: string) => order.indexOf(key) + 1 || order.length + 1;
	return Object.fromEntries(
		Object.entries(values).sort(([a], [b]) => rank(a) - rank(b)),
	);
}

/** Read and patch declared Markdown fields without changing undeclared lines. */
export function createMarkdownRecords({
	fields,
	local = false,
	keysOf,
	single = false,
}: {
	fields: Fields;
	local?: boolean;
	keysOf: (path: string) => Record<string, string> | undefined;
	/** Collections alone read an absent one-file record as empty. */
	single?: boolean;
}) {
	function unknownField(path: string, key: string) {
		if (!Object.hasOwn(fields, key))
			return ActionError.Refused({ message: `${path} has no field "${key}"` });
	}
	/**
	 * The file at `path` as a read gives it, with each problem and its kind,
	 * and the partial record for repair. Each field is its value if it
	 * fits, else absent; an absent switch or list is `false` or `[]`.
	 * Its diagnostics name each value that did not fit, each line whose text is
	 * not JSON with what to write, and each required field that is missing.
	 * `path`, the keys, and `body` come from the file, and no field can be
	 * named as one of them. A field whose line is not JSON counts among the
	 * values that did not fit.
	 */
	function project(path: string, found: Found) {
		const { fields: values, problems } = projectFields(fields, found, local);
		const record: AnyRecord = {
			path,
			...keysOf(path),
			...values,
			body: found.body,
		};
		const result: Result<AnyRecord, Misfit> = problems.length
			? ActionError.Misfit({
					path,
					problems,
					...(!local && found.readable ? { record } : {}),
				})
			: Ok(record);
		return { record, result };
	}

	/** Split a patch into fields to set and remove, and check each supplied value. */
	function patchOf(
		path: string,
		given: Record<string, unknown>,
		creating: boolean,
	) {
		const removed: string[] = [];
		const set: FieldValues = {};
		for (const [key, value] of Object.entries(given)) {
			const unknown = unknownField(path, key);
			if (unknown) return unknown;
			if (value === undefined) continue;
			if (value === null && isOptional(fields[key] as TSchema))
				removed.push(key);
			else if (value === null && !creating) {
				return ActionError.Refused({
					message: `${key} is required, so it cannot be removed`,
				});
			} else set[key] = value as JsonValue;
		}
		const problems: string[] = [];
		for (const [key, schema] of Object.entries(fields)) {
			if (Object.hasOwn(set, key)) {
				if (!Value.Check(schema, set[key]))
					problems.push(misfit(key, schema, set[key], local));
			} else if (
				creating &&
				!isOptional(schema) &&
				absentValue(schema) === undefined
			)
				problems.push(`${key} is missing`);
		}
		if (problems.length)
			return ActionError.Refused({
				message: problems.map((problem) => `${path}: ${problem}`).join('\n'),
			});
		return Ok({ set: inDeclaredOrder(set, fields), removed });
	}

	/** Decide a record and its replacement together, once per attempt at the current file. */
	function write(
		path: string,
		need: Need,
		computed: boolean,
		change: (record: AnyRecord | undefined) => Result<Write, CallbackError>,
	) {
		return folder.edit<AnyRecord, CallbackError>(
			path,
			decide(path, need, computed, change),
		);
	}

	function decide(
		path: string,
		need: Need,
		computed: boolean,
		change: (record: AnyRecord | undefined) => Result<Write, CallbackError>,
	): (
		before: string | undefined,
	) => Result<{ value: AnyRecord; text?: string }, CallbackError> {
		return (before) => {
			if (before === undefined && need === 'present' && !single)
				return ActionError.Missing({ path });
			if (before !== undefined && need === 'absent')
				return ActionError.Refused({ message: `${path} is already there` });

			const found = readMarkdown(before ?? '');
			const current =
				before !== undefined || single ? project(path, found) : undefined;
			if (current?.result.error && (computed || !found.readable))
				return current.result;
			const changed = change(current?.record);
			if (changed.error !== null) return changed;
			const { fields: given, body } = changed.data;
			if (body !== undefined && typeof body !== 'string')
				return ActionError.Refused({ message: `${path}: body must be text` });
			const patch = patchOf(path, given, before === undefined);
			if (patch.error !== null) return patch;
			const { set, removed } = patch.data;
			if (
				current &&
				!removed.length &&
				!Object.keys(set).length &&
				body === undefined
			)
				return current.result.error
					? current.result
					: Ok({ value: current.record });

			let after: string;
			if (before === undefined) after = markdownOf(set, body ?? '');
			else {
				const fielded = withFields(before, set, removed);
				after =
					body === undefined
						? fielded
						: fielded.slice(0, fielded.length - found.body.length) + body;
			}
			if (after === before && current)
				return current.result.error
					? current.result
					: Ok({ value: current.record });
			const next = project(path, readMarkdown(after)).result;
			if (next.error !== null)
				return current?.result.error ? current.result : next;
			// A keyless record already reads as its defaults while its file is absent.
			if (
				before === undefined &&
				current &&
				Value.Equal(current.record, next.data)
			)
				return Ok({ value: next.data });
			return Ok({ value: next.data, text: after });
		};
	}

	/** A computed change must explicitly return Ok(change) or Err(error). */
	const computed =
		(
			change: (record: AnyRecord | undefined) => unknown,
			method: 'set' | 'update',
			identity: readonly string[] = [],
		) =>
		(now: AnyRecord | undefined): Result<Write, CallbackError> => {
			const result = change(structuredClone(now));
			if (!isActionResult(result))
				throw new Error(
					`The change given to ${method} must return a Result: Ok(change) or Err(error)`,
				);
			if (result.error !== null) return result;
			if (
				typeof result.data !== 'object' ||
				result.data === null ||
				Array.isArray(result.data)
			)
				throw new Error(
					`The change given to ${method} must return a record patch inside Ok`,
				);
			const { body, ...given } = result.data as Record<string, unknown>;
			for (const key of identity) delete given[key];
			return Ok({ fields: given, body });
		};

	return { project, write, decide, computed, unknownField };
}
