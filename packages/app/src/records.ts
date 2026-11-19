import { join, parse } from 'node:path';
import type { TSchema } from 'typebox';
import { Value } from 'typebox/value';
import { Ok, type Result } from 'wellcrafted/result';
import { isAnswer, isPlainObject } from './answer.ts';
import { editFile, readText } from './disk.ts';
import {
	ActionError,
	type Misfit,
	type Problem,
	type PublicError,
} from './errors.ts';
import { type Fields, isOptional, refKeyOf, whatFits } from './field.ts';
import {
	changeMarkdown,
	type FieldValues,
	type JsonValue,
	type MarkdownFile,
	type NotJson,
	readMarkdown,
} from './markdown.ts';

export type AnyRecord = Record<string, JsonValue> & {
	path: string;
	id: string;
	body: string;
};
/** A change as data: each field to set, `null` to remove an optional one, and `body`. */
type Patch = Record<string, unknown>;
/** A change computed from the record: it returns `Ok(patch)` or `Err(error)`. */
type Compute = (record: AnyRecord | undefined) => unknown;
type Need = 'absent' | 'present' | 'either';

/**
 * The id of the file at `path`: Node's name for it when Node calls its
 * extension `.md`, else undefined. `notes/.foo.md` is `.foo` and
 * `notes/...md` is `..`; `notes/.md` and `notes/x.md.bak` are no record.
 */
export function idOf(path: string) {
	const { ext, name } = parse(path);
	return ext === '.md' ? name : undefined;
}

/**
 * Whether `id` names a record: Node gives `<id>.md` back with that id as its
 * name, and it has no `\`, which Windows reads as a separator. `''`, `a/b`,
 * `../x`, `x/`, `a\b` and any value that is not text do not, so every id `create` writes, `list`
 * reads back as the same id.
 */
export function isId(id: unknown): id is string {
	return (
		typeof id === 'string' && idOf(`${id}.md`) === id && !id.includes('\\')
	);
}

/** One ref a value holds: the key it points into, the id, and where it sits. */
type Ref = { target: string; id: string; at: string };

/**
 * The refs `value` holds, read through `schema`: the value itself when the
 * schema is a ref, or each item when it is a list. A write checks these;
 * `defineData` refuses a ref in any other shape (`refTargets`).
 */
function refsIn(schema: unknown, value: unknown, at: string): Ref[] {
	const target = refKeyOf(schema);
	if (target !== undefined)
		return typeof value === 'string' ? [{ target, id: value, at }] : [];
	const { items } = schema as { items?: unknown };
	if (items === undefined || !Array.isArray(value)) return [];
	return value.flatMap((item, index) => refsIn(items, item, `${at}[${index}]`));
}

/** The keys the refs in `schema` point into, walked as `refsIn` walks a value. */
export function refTargets(schema: unknown): string[] {
	const target = refKeyOf(schema);
	if (target !== undefined) return [target];
	const { items } = (schema ?? {}) as { items?: unknown };
	return items === undefined ? [] : refTargets(items);
}

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
	const words = whatFits(schema, value);
	const why = words
		? `is not ${words}`
		: (Value.Errors(schema, value)[0]?.message ?? 'does not fit');
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
function inDeclaredOrder(values: FieldValues, fields: Fields) {
	const order = Object.keys(fields);
	const rank = (key: string) => order.indexOf(key) + 1 || order.length + 1;
	return Object.fromEntries(
		Object.entries(values).sort(([a], [b]) => rank(a) - rank(b)),
	);
}

/** Read and write records of declared Markdown fields without changing undeclared lines. */
export function createMarkdownRecords({
	home,
	base,
	fields,
	idsIn,
}: {
	/** The home's folder. */
	home: string;
	/** The folder under the home that holds one file per id, such as `data/notes`. */
	base: string;
	fields: Fields;
	/** The ids `list` reads in the key `key`, for the refs a write sets. */
	idsIn: (key: string) => string[];
}) {
	/** The file for `id`, as given. */
	const pathOf = (id: string) => `${base}/${id}.md`;

	/** A change that does not fit the declared fields, as one problem. */
	function unfit(id: string, line: string, kind = line) {
		return ActionError.Misfit({
			path: pathOf(id),
			id,
			problems: [{ line, kind }],
		});
	}

	/**
	 * The record `file` gives for `id`, and the result a read answers: the
	 * record, or a Misfit with each problem and, when the front matter can be
	 * read, the record for repair. Each field is its value if it fits, else
	 * absent. `path`, `id`,
	 * and `body` come from the file, and no field can be named as one of them.
	 */
	function project(id: string, file: MarkdownFile) {
		const path = pathOf(id);
		const values: FieldValues = {};
		const problems: Problem[] = file.readable ? [] : [UNREADABLE];
		for (const [key, schema] of Object.entries(fields)) {
			const value = file.fields[key];
			const bare = file.notJson.find((each) => each.key === key);
			if (bare) problems.push(notJsonProblem(key, schema, bare));
			else if (!Object.hasOwn(file.fields, key)) {
				if (file.readable && !isOptional(schema))
					problems.push(problem(`${key} is missing`));
			} else if (Value.Check(schema, value)) values[key] = value as JsonValue;
			else problems.push(misfit(key, schema, value));
		}
		const record: AnyRecord = { path, id, ...values, body: file.body };
		const result: Result<AnyRecord, Misfit> = problems.length
			? ActionError.Misfit({
					path,
					id,
					problems,
					...(file.readable ? { record } : {}),
				})
			: Ok(record);
		return { record, result };
	}

	/** The record for `id`, or undefined when there is no file. */
	async function read(
		id: string,
	): Promise<Result<AnyRecord | undefined, Misfit>> {
		const text = await readText(join(home, pathOf(id)));
		if (text === undefined) return Ok(undefined);
		return project(id, readMarkdown(text)).result;
	}

	/**
	 * Split a patch into fields to set and remove, and check each supplied
	 * value. A ref is checked when this write changes it: one `old` already
	 * holds in that field passes, so a caller that sends every field back can
	 * save a record whose ref names a deleted record.
	 */
	function fieldsOf(id: string, given: Patch, old: FieldValues | undefined) {
		const creating = old === undefined;
		const removed: string[] = [];
		const set: FieldValues = {};
		for (const [key, value] of Object.entries(given)) {
			if (!Object.hasOwn(fields, key))
				return unfit(id, `has no field "${key}"`, 'has no such field');
			const schema = fields[key] as TSchema;
			if (value === undefined) continue;
			if (value === null && isOptional(schema)) removed.push(key);
			else if (value === null && !creating)
				return unfit(id, `${key} is required, so it cannot be removed`);
			else set[key] = value as JsonValue;
		}
		const problems: Problem[] = [];
		// The same names `list` reads.
		const has = ({ target, id }: Ref) => isId(id) && idsIn(target).includes(id);
		const same = (a: Ref) => (b: Ref) => a.target === b.target && a.id === b.id;
		for (const [key, schema] of Object.entries(fields)) {
			if (Object.hasOwn(set, key)) {
				if (!Value.Check(schema, set[key])) {
					problems.push(misfit(key, schema, set[key]));
					continue;
				}
				const kept = old ? refsIn(schema, old[key], key) : [];
				for (const ref of refsIn(schema, set[key], key))
					if (!kept.some(same(ref)) && !has(ref))
						problems.push({
							line: `${ref.at} ${JSON.stringify(ref.id)} names no record in ${ref.target}`,
							kind: `${ref.at} names no record in ${ref.target}`,
						});
			} else if (creating && !isOptional(schema))
				problems.push(problem(`${key} is missing`));
		}
		if (problems.length)
			return ActionError.Misfit({ path: pathOf(id), id, problems });
		return Ok({ set: inDeclaredOrder(set, fields), removed });
	}

	/**
	 * Decide a record and its replacement together, in one `edit` of the
	 * current file. `need` refuses an absent file with Missing and a present
	 * one with Exists. A patch may repair a record with problems; a
	 * computed change sees only a record that fits.
	 */
	async function write(
		id: string,
		need: Need,
		change: Patch | Compute,
	): Promise<Result<AnyRecord, PublicError>> {
		const path = pathOf(id);
		return editFile<AnyRecord, PublicError>(home, path, (before) => {
			if (before === undefined && need === 'present')
				return ActionError.Missing({ path });
			if (before !== undefined && need === 'absent')
				return ActionError.Exists({ path });

			const file = readMarkdown(before ?? '');
			const current = before === undefined ? undefined : project(id, file);
			const computed = typeof change === 'function';
			if (current?.result.error && (computed || !file.readable))
				return current.result;

			let patch = change as Patch;
			if (computed) {
				const result = change(structuredClone(current?.record));
				if (!isAnswer(result))
					throw new Error(
						'The change given to edit must return a Result: Ok(change) or Err(error)',
					);
				if (result.error !== null) return result;
				if (!isPlainObject(result.data))
					throw new Error(
						'The change given to edit must return a record patch inside Ok',
					);
				patch = result.data;
			}
			// A spread of the record carries its path and id, which name it and are not fields.
			const named = ['path', 'id'].filter((key) => Object.hasOwn(patch, key));
			if (named.length)
				return unfit(
					id,
					`the change names ${named.join(' and ')}, which name the record and are not fields; give only the fields that change, such as { done: true }`,
					'the change names the record, not only the fields that change',
				);

			const { body, ...given } = patch;
			if (body !== undefined && typeof body !== 'string')
				return unfit(id, 'body must be text');
			const checked = fieldsOf(
				id,
				given,
				before === undefined ? undefined : file.fields,
			);
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
			const next = project(id, readMarkdown(after)).result;
			if (next.error !== null)
				return current?.result.error ? current.result : next;
			return Ok({ value: next.data, text: after });
		});
	}

	return { path: pathOf, read, write };
}
