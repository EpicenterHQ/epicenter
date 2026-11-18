import { join } from 'node:path';
import type { Static, TSchema } from 'typebox';
import { Value } from 'typebox/value';
import { Ok, type Result } from 'wellcrafted/result';
import {
	isActionResult,
	isPlainObject,
	type PublicError,
} from './action-result.ts';
import { ActionError, type Problem } from './errors.ts';
import {
	absentValue,
	type FilledKeys,
	isOptional,
	type OptionalKeys,
	whatFits,
} from './field.ts';
import { type Folder, readText } from './folder.ts';
import {
	changeMarkdown,
	type FieldValues,
	type JsonValue,
	type MarkdownFile,
	type NotJson,
	readMarkdown,
} from './front-matter.ts';

/** Declared front matter fields, each a TypeBox schema. */
export type Fields = Record<string, TSchema>;

type ValueOf<F extends Fields, K extends keyof F> = Exclude<
	Static<F[K]>,
	undefined
>;
type MayLack<F> = Exclude<OptionalKeys<F>, FilledKeys<F>>;

/** Required fields, filled switches and lists, and possibly absent optional fields. */
export type Fitting<F extends Fields> = {
	-readonly [K in Exclude<keyof F, MayLack<F>>]-?: ValueOf<F, K>;
} & { -readonly [K in MayLack<F>]?: ValueOf<F, K> };

/** Fields that fit, with invalid or missing fields absent. */
export type Loose<F extends Fields> = {
	-readonly [K in keyof F]?: ValueOf<F, K>;
};

export type AnyRecord = Record<string, unknown> & {
	path: string;
	body: string;
};
/** A change as data: each field to set, `null` to remove an optional one, and `body`. */
export type Patch = Record<string, unknown>;
/** A change computed from the record: it returns `Ok(patch)` or `Err(error)`. */
export type Compute = (record: AnyRecord | undefined) => unknown;
type Misfit = Extract<ActionError, { name: 'Misfit' }>;
type Need = 'absent' | 'present' | 'either';

/** A problem with nothing file-specific in it, so its line is its kind. */
const problem = (line: string): Problem => ({ line, kind: line });

const UNREADABLE = problem(
	'its front matter is not key: value lines between two --- lines, each key once',
);

/**
 * Why a supplied field value does not fit its schema. The problem's `kind`
 * leaves the value out, so many files can share it.
 */
function misfit(key: string, schema: TSchema, value: unknown): Problem {
	let why = 'does not fit';
	const words = whatFits(schema, value);
	if (words) why = `is not ${words}`;
	else {
		const [error] = Value.Errors(schema, value);
		if (error) why = error.message;
	}
	return {
		line: `${key}: ${JSON.stringify(value)} ${why}`,
		kind: `${key} ${why}`,
	};
}

/**
 * What to write for a declared key whose line is not JSON. The problem's
 * `line` names the line number and the exact line to write; its `kind`
 * leaves both out.
 */
function notJsonProblem(
	key: string,
	schema: TSchema,
	{ lineNumber, text }: NotJson,
): Problem {
	const notJson = (fix: string, kindFix = fix) => ({
		line: `${key} on line ${lineNumber} is not JSON${fix}`,
		kind: `${key} is not JSON${kindFix}`,
	});
	if (text.trim() === '')
		return notJson(
			': it has no value; give it one as JSON, or remove the line',
		);
	if (Value.Check(schema, text))
		return notJson(
			`; write ${key}: ${JSON.stringify(text)}`,
			'; write its text in double quotes',
		);
	const words = whatFits(schema, text);
	return notJson(
		words
			? `; ${key} takes ${words}, written as JSON`
			: '; write its value as JSON',
	);
}

/** `values` in the order the data key declares its fields, then the rest. */
function inDeclaredOrder(values: FieldValues, fields: Fields): FieldValues {
	const order = Object.keys(fields);
	const rank = (key: string) => order.indexOf(key) + 1 || order.length + 1;
	return Object.fromEntries(
		Object.entries(values).sort(([a], [b]) => rank(a) - rank(b)),
	);
}

/** Read and write records of declared Markdown fields without changing undeclared lines. */
export function createMarkdownRecords({
	folder,
	fields,
	keysOf,
}: {
	folder: Folder;
	fields: Fields;
	keysOf: (path: string) => Record<string, string>;
}) {
	/** A change that does not fit the declared fields, as one problem at `path`. */
	function unfit(path: string, line: string, kind = line) {
		return ActionError.Misfit({
			path,
			id: keysOf(path).id,
			problems: [{ line, kind }],
		});
	}

	/**
	 * The record `file` gives at `path`, and the result a read answers: the
	 * record, or a Misfit with each problem and, when the front matter can be
	 * read, the record for repair. Each field is its value if it fits, else
	 * absent; an absent switch or list is `false` or `[]`. `path`, the keys,
	 * and `body` come from the file, and no field can be named as one of them.
	 */
	function project(path: string, file: MarkdownFile) {
		const values: Record<string, unknown> = {};
		const problems: Problem[] = file.readable ? [] : [UNREADABLE];
		for (const [key, schema] of Object.entries(fields)) {
			const value = file.fields[key];
			const bare = file.notJson.find((each) => each.key === key);
			if (bare) problems.push(notJsonProblem(key, schema, bare));
			else if (!Object.hasOwn(file.fields, key)) {
				const absent = absentValue(schema);
				if (absent !== undefined) values[key] = structuredClone(absent);
				else if (file.readable && !isOptional(schema))
					problems.push(problem(`${key} is missing`));
			} else if (Value.Check(schema, value)) values[key] = value;
			else problems.push(misfit(key, schema, value));
		}
		const keys = keysOf(path);
		const record: AnyRecord = { path, ...keys, ...values, body: file.body };
		const result: Result<AnyRecord, Misfit> = problems.length
			? ActionError.Misfit({
					path,
					id: keys.id,
					problems,
					...(file.readable ? { record } : {}),
				})
			: Ok(record);
		return { record, result };
	}

	/** The record at `path`, or undefined when there is no file. */
	async function read(
		path: string,
	): Promise<Result<AnyRecord | undefined, Misfit>> {
		const text = await readText(join(folder.path, path));
		if (text === undefined) return Ok(undefined);
		return project(path, readMarkdown(text)).result;
	}

	/** Split a patch into fields to set and remove, and check each supplied value. */
	function fieldsOf(path: string, given: Patch, creating: boolean) {
		const removed: string[] = [];
		const set: FieldValues = {};
		for (const [key, value] of Object.entries(given)) {
			if (!Object.hasOwn(fields, key))
				return unfit(path, `has no field "${key}"`, 'has no such field');
			const schema = fields[key] as TSchema;
			if (value === undefined) continue;
			if (value === null && isOptional(schema)) removed.push(key);
			else if (value === null && !creating)
				return unfit(path, `${key} is required, so it cannot be removed`);
			else set[key] = value as JsonValue;
		}
		const problems: Problem[] = [];
		for (const [key, schema] of Object.entries(fields)) {
			if (Object.hasOwn(set, key)) {
				if (!Value.Check(schema, set[key]))
					problems.push(misfit(key, schema, set[key]));
			} else if (
				creating &&
				!isOptional(schema) &&
				absentValue(schema) === undefined
			)
				problems.push(problem(`${key} is missing`));
		}
		if (problems.length)
			return ActionError.Misfit({ path, id: keysOf(path).id, problems });
		return Ok({ set: inDeclaredOrder(set, fields), removed });
	}

	/**
	 * Decide a record and its replacement together, once per attempt at the
	 * current file. `need` refuses an absent file with Missing and a present
	 * one with Changed (there). A patch may repair a record with problems; a
	 * computed change sees only a record that fits.
	 */
	async function write(
		path: string,
		need: Need,
		change: Patch | Compute,
	): Promise<Result<AnyRecord, PublicError>> {
		const written = await folder.edit<AnyRecord, PublicError>(
			path,
			(before) => {
				if (before === undefined && need === 'present')
					return ActionError.Missing({ path });
				if (before !== undefined && need === 'absent')
					return ActionError.Changed({ path, cause: 'there' });

				const file = readMarkdown(before ?? '');
				const current = before === undefined ? undefined : project(path, file);
				const computed = typeof change === 'function';
				if (current?.result.error && (computed || !file.readable))
					return current.result;

				let patch = change as Patch;
				if (computed) {
					const result = change(structuredClone(current?.record));
					if (!isActionResult(result))
						throw new Error(
							'The change given to edit must return a Result: Ok(change) or Err(error)',
						);
					if (result.error !== null) return result;
					if (!isPlainObject(result.data))
						throw new Error(
							'The change given to edit must return a record patch inside Ok',
						);
					// A spread of the record carries its path and keys, which are not fields.
					const identity = ['path', ...Object.keys(keysOf(path))];
					patch = Object.fromEntries(
						Object.entries(result.data).filter(
							([key]) => !identity.includes(key),
						),
					);
				}

				const { body, ...given } = patch;
				if (body !== undefined && typeof body !== 'string')
					return unfit(path, 'body must be text');
				const checked = fieldsOf(path, given, before === undefined);
				if (checked.error !== null) return checked;
				const { set, removed } = checked.data;
				const after = changeMarkdown(before ?? '', { set, removed, body });
				// A file without front matter gains fences on any write, so an
				// empty change is caught before its text is compared.
				const empty =
					!Object.keys(set).length && !removed.length && body === undefined;
				if (current && (empty || after === before))
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
		return written as Result<AnyRecord, PublicError>;
	}

	return { read, write };
}
