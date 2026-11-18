import type { Static, TSchema } from 'typebox';
import { Value } from 'typebox/value';
import { Ok, type Result } from 'wellcrafted/result';
import { isActionResult } from './action-result.ts';
import { ActionError, type Problem } from './errors.ts';
import { absentValue, type FilledKeys, whatFits } from './field.ts';
import type { Folder } from './folder.ts';
import {
	type FieldValues,
	type JsonValue,
	markdownOf,
	readMarkdown,
	withFields,
} from './front-matter.ts';

/** Declared front matter fields, each a TypeBox schema. */
export type Fields = Record<string, TSchema>;

type ValueOf<F extends Fields, K extends keyof F> = Exclude<
	Static<F[K]>,
	undefined
>;
type OptionalKeys<F> = {
	[K in keyof F]: F[K] extends { '~optional': true } ? K : never;
}[keyof F];
type MayLack<F> = Exclude<OptionalKeys<F>, FilledKeys<F>>;

/** Required fields, filled switches and lists, and possibly absent optional fields. */
export type Fitting<F extends Fields> = {
	-readonly [K in Exclude<keyof F, MayLack<F>>]-?: ValueOf<F, K>;
} & { -readonly [K in MayLack<F>]?: ValueOf<F, K> };

/** Fields that fit, with invalid or missing fields absent. */
export type Loose<F extends Fields> = {
	-readonly [K in keyof F]?: ValueOf<F, K>;
};

export const isOptional = (schema: TSchema) =>
	(schema as { '~optional'?: boolean })['~optional'] === true;

/**
 * Why a supplied field value does not fit its schema. `withoutValue` leaves the value
 * out, giving the kind of problem that many files can share.
 */
export function misfit(
	key: string,
	schema: TSchema,
	value: unknown,
	withoutValue = false,
): string {
	const quoted = withoutValue ? key : `${key}: ${JSON.stringify(value)}`;
	const words = whatFits(schema, value);
	if (words) return `${quoted} is not ${words}`;
	const [error] = Value.Errors(schema, value);
	return `${quoted} ${error?.message ?? 'does not fit'}`;
}

function notJsonProblem(
	key: string,
	schema: TSchema,
	{ line, text }: { line?: number; text: string },
	withoutValue: boolean,
): string {
	const which = `${key}${line === undefined ? '' : ` on line ${line}`} is not JSON`;
	if (text.trim() === '')
		return `${which}: it has no value; give it one as JSON, or remove the line`;
	if (Value.Check(schema, text))
		return `${which}; write ${withoutValue ? 'its text in double quotes' : `${key}: ${JSON.stringify(text)}`}`;
	const words = whatFits(schema, text);
	return words
		? `${which}; ${key} takes ${words}, written as JSON`
		: `${which}; write its value as JSON`;
}

const UNREADABLE =
	'its front matter is not key: value lines between two --- lines, each key once';

/**
 * Project one file's declared fields, retaining every diagnostic for repair.
 * Each problem's `kind` is its line without the file's values.
 */
export function projectFields(
	fields: Fields,
	found: ReturnType<typeof readMarkdown>,
) {
	const values: Record<string, unknown> = {};
	const problems: Problem[] = [];
	const problem = (line: string, kind = line) => problems.push({ line, kind });
	if (!found.readable) problem(UNREADABLE);
	const notJson = new Map(found.notJson.map((each) => [each.key, each]));
	for (const [key, schema] of Object.entries(fields)) {
		const value = found.fields[key];
		const bare = notJson.get(key);
		if (bare) {
			problem(
				notJsonProblem(key, schema, bare, false),
				notJsonProblem(key, schema, { text: bare.text }, true),
			);
		} else if (!Object.hasOwn(found.fields, key)) {
			const absent = absentValue(schema);
			if (absent !== undefined) values[key] = structuredClone(absent);
			else if (found.readable && !isOptional(schema))
				problem(`${key} is missing`);
		} else if (Value.Check(schema, value)) values[key] = value;
		else problem(misfit(key, schema, value), misfit(key, schema, value, true));
	}
	return { fields: values, problems };
}

type Misfit = Extract<ActionError, { name: 'Misfit' }>;
export type CallbackError = { name: string; message: string };
export type AnyRecord = Record<string, unknown> & {
	path: string;
	body: string;
};
type Write = { fields: Record<string, unknown>; body?: unknown };
type Need = 'absent' | 'present' | 'either';
type Found = ReturnType<typeof readMarkdown>;

/** `values` in the order the data key declares its fields, then the rest. */
function inDeclaredOrder(values: FieldValues, fields: Fields): FieldValues {
	const order = Object.keys(fields);
	const rank = (key: string) => order.indexOf(key) + 1 || order.length + 1;
	return Object.fromEntries(
		Object.entries(values).sort(([a], [b]) => rank(a) - rank(b)),
	);
}

/** Read and patch declared Markdown fields without changing undeclared lines. */
export function createMarkdownRecords({
	folder,
	fields,
	keysOf,
}: {
	folder: Folder;
	fields: Fields;
	keysOf: (path: string) => Record<string, string> | undefined;
}) {
	/** A change that does not fit the declared fields, as one problem at `path`. */
	function unfit(path: string, line: string, kind = line) {
		return ActionError.Misfit({
			path,
			id: keysOf(path)?.id,
			problems: [{ line, kind }],
		});
	}
	function unknownField(path: string, key: string) {
		if (!Object.hasOwn(fields, key))
			return unfit(path, `has no field "${key}"`, 'has no such field');
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
		const { fields: values, problems } = projectFields(fields, found);
		const keys = keysOf(path);
		const record: AnyRecord = {
			path,
			...keys,
			...values,
			body: found.body,
		};
		const result: Result<AnyRecord, Misfit> = problems.length
			? ActionError.Misfit({
					path,
					id: keys?.id,
					problems,
					...(found.readable ? { record } : {}),
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
				return unfit(path, `${key} is required, so it cannot be removed`);
			} else set[key] = value as JsonValue;
		}
		const problems: Problem[] = [];
		for (const [key, schema] of Object.entries(fields)) {
			if (Object.hasOwn(set, key)) {
				if (!Value.Check(schema, set[key]))
					problems.push({
						line: misfit(key, schema, set[key]),
						kind: misfit(key, schema, set[key], true),
					});
			} else if (
				creating &&
				!isOptional(schema) &&
				absentValue(schema) === undefined
			)
				problems.push({ line: `${key} is missing`, kind: `${key} is missing` });
		}
		if (problems.length)
			return ActionError.Misfit({ path, id: keysOf(path)?.id, problems });
		return Ok({ set: inDeclaredOrder(set, fields), removed });
	}

	/**
	 * Decide a record and its replacement together, once per attempt at the
	 * current file. `need` refuses an absent file with Missing and a present
	 * one with Changed (there).
	 */
	async function write(
		path: string,
		need: Need,
		computed: boolean,
		change: (record: AnyRecord | undefined) => Result<Write, CallbackError>,
	): Promise<Result<AnyRecord, CallbackError>> {
		const written = await folder.edit<AnyRecord, CallbackError>(
			path,
			(before) => {
				if (before === undefined && need === 'present')
					return ActionError.Missing({ path });
				if (before !== undefined && need === 'absent')
					return ActionError.Changed({ path, cause: 'there' });

				const found = readMarkdown(before ?? '');
				const current = before !== undefined ? project(path, found) : undefined;
				if (current?.result.error && (computed || !found.readable))
					return current.result;
				const changed = change(current?.record);
				if (changed.error !== null) return changed;
				const { fields: given, body } = changed.data;
				if (body !== undefined && typeof body !== 'string')
					return unfit(path, 'body must be text');
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
				return Ok({ value: next.data, text: after });
			},
		);
		// Every Ok above carries the record as its value.
		return written as Result<AnyRecord, CallbackError>;
	}

	/** A computed change must explicitly return Ok(change) or Err(error). */
	const computed =
		(
			change: (record: AnyRecord | undefined) => unknown,
			identity: readonly string[] = [],
		) =>
		(now: AnyRecord | undefined): Result<Write, CallbackError> => {
			const result = change(structuredClone(now));
			if (!isActionResult(result))
				throw new Error(
					'The change given to edit must return a Result: Ok(change) or Err(error)',
				);
			if (result.error !== null) return result;
			if (
				typeof result.data !== 'object' ||
				result.data === null ||
				Array.isArray(result.data)
			)
				throw new Error(
					'The change given to edit must return a record patch inside Ok',
				);
			const { body, ...given } = result.data as Record<string, unknown>;
			for (const key of identity) delete given[key];
			return Ok({ fields: given, body });
		};

	return { project, write, computed, unknownField };
}
