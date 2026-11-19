import { join, parse } from 'node:path';
import type { TSchema } from 'typebox';
import { Value } from 'typebox/value';
import { type Err, Ok, type Result } from 'wellcrafted/result';
import {
	ActionError,
	isResult,
	type Misfit,
	type PublicError,
} from './answer.ts';
import type { DataDef } from './data.ts';
import {
	filesIn,
	firstNonFolder,
	readBytes,
	removeFile,
	replaceFile,
} from './disk.ts';
import { type Fields, isOptional, whyNot } from './field.ts';
import { isPlainObject } from './json.ts';
import {
	changeMarkdown,
	type FieldValues,
	type JsonValue,
	type MarkdownFile,
	type NotJson,
	readMarkdown,
} from './markdown.ts';

type AnyRecord = Record<string, JsonValue> & {
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
function idOf(path: string) {
	const { ext, name } = parse(path);
	return ext === '.md' ? name : undefined;
}

/**
 * Whether `id` names a record: Node gives `<id>.md` back with that id as its
 * name, and it has no `\`, which Windows reads as a separator. `''`, `a/b`,
 * `../x`, `x/`, `a\b` and any value that is not text do not, so every id `create` writes, `list`
 * reads back as the same id.
 */
function isId(id: unknown): id is string {
	return (
		typeof id === 'string' && idOf(`${id}.md`) === id && !id.includes('\\')
	);
}

const UNREADABLE =
	'its front matter is not key: value lines between two --- lines, each key once';

/** Why a supplied field value does not fit its schema, with the value. */
const valueProblem = (key: string, schema: TSchema, value: unknown) =>
	`${whyNot(key, schema, value)}, not ${JSON.stringify(value)}`;

/**
 * What to write for a declared key whose line is not JSON: the exact line
 * when its text fits as a string, which is the usual slip.
 */
function notJsonProblem(
	key: string,
	schema: TSchema,
	{ lineNumber, text }: NotJson,
) {
	const fix = Value.Check(schema, text)
		? `write ${key}: ${JSON.stringify(text)}`
		: 'write its value as JSON';
	return `${key} on line ${lineNumber} is not JSON; ${fix}`;
}

/** `values` in the order the data key declares its fields, then the rest. */
function inDeclaredOrder(values: FieldValues, fields: Fields) {
	const order = Object.keys(fields);
	const rank = (key: string) => order.indexOf(key) + 1 || order.length + 1;
	return Object.fromEntries(
		Object.entries(values).sort(([a], [b]) => rank(a) - rank(b)),
	);
}

/**
 * The handle for one data key: its definition, and calls that read and
 * write `data/<key>/<id>.md` under `home` without changing undeclared lines.
 * Every file call is synchronous (`disk.ts`), so a write reads, decides and
 * replaces its file with nothing else in serve between.
 */
export function createHandle(home: string, key: string, def: DataDef) {
	const { fields } = def;
	const folder = `data/${key}`;
	/** The file for `id`, from the home. */
	const pathOf = (id: string) => `${folder}/${id}.md`;
	/**
	 * Throw unless the key's folder is real, before any file call: a read
	 * through a link would show records a write cannot reach.
	 */
	function refuseLinked() {
		const refused = firstNonFolder(home, folder);
		if (refused !== undefined)
			throw new Error(
				`${refused} is a link or a file, not a folder; records are read and written only in real folders under data/`,
			);
	}

	/** A change that does not fit the declared fields, as one problem. */
	function misfitFor(id: string, problem: string) {
		return ActionError.Misfit({ path: pathOf(id), id, problems: [problem] });
	}

	/**
	 * The record `file` gives for `id`, and the result a read answers: the
	 * record, or a Misfit with each problem and, when the front matter can be
	 * read, the record for repair. Each field is its value if it fits, else
	 * absent. `path`, `id` and `body` come from the file, and no field can be
	 * named as one of them.
	 */
	function recordFrom(id: string, file: MarkdownFile) {
		const path = pathOf(id);
		const values: FieldValues = {};
		const problems: string[] = file.readable ? [] : [UNREADABLE];
		for (const [key, schema] of Object.entries(fields)) {
			const value = file.fields[key];
			const bare = file.notJson.find((each) => each.key === key);
			if (bare) problems.push(notJsonProblem(key, schema, bare));
			else if (!Object.hasOwn(file.fields, key)) {
				if (file.readable && !isOptional(schema))
					problems.push(`${key} is missing`);
			} else if (Value.Check(schema, value)) values[key] = value as JsonValue;
			else problems.push(valueProblem(key, schema, value));
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

	/**
	 * The record for `id`, or undefined when there is no file. The caller has
	 * checked that the key's folder is real.
	 */
	function read(id: string): Result<AnyRecord | undefined, Misfit> {
		const bytes = readBytes(join(home, pathOf(id)));
		if (bytes === undefined) return Ok(undefined);
		return recordFrom(id, readMarkdown(new TextDecoder().decode(bytes))).result;
	}

	/** Split a patch into fields to set and remove, and check each supplied value. */
	function splitPatch(id: string, given: Patch, creating: boolean) {
		const removed: string[] = [];
		const set: FieldValues = {};
		for (const [key, value] of Object.entries(given)) {
			if (!Object.hasOwn(fields, key))
				return misfitFor(id, `has no field "${key}"`);
			const schema = fields[key] as TSchema;
			if (value === undefined) continue;
			if (value === null && isOptional(schema)) removed.push(key);
			else if (value === null && !creating)
				return misfitFor(id, `${key} is required, so it cannot be removed`);
			else set[key] = value as JsonValue;
		}
		const problems: string[] = [];
		for (const [key, schema] of Object.entries(fields)) {
			if (Object.hasOwn(set, key)) {
				if (!Value.Check(schema, set[key]))
					problems.push(valueProblem(key, schema, set[key]));
			} else if (creating && !isOptional(schema))
				problems.push(`${key} is missing`);
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
	function planWrite(
		id: string,
		need: Need,
		change: Patch | Compute,
		before: string | undefined,
	): Result<{ value: AnyRecord; text?: string }, PublicError> {
		const path = pathOf(id);
		if (before === undefined && need === 'present')
			return ActionError.Missing({ path });
		if (before !== undefined && need === 'absent')
			return ActionError.Exists({ path });

		const file = readMarkdown(before ?? '');
		const current = before === undefined ? undefined : recordFrom(id, file);
		const computed = typeof change === 'function';
		if (current?.result.error && (computed || !file.readable))
			return current.result;

		let patch = change as Patch;
		if (computed) {
			const result = change(structuredClone(current?.record));
			if (!isResult(result))
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
			return misfitFor(
				id,
				`the change names ${named.join(' and ')}, which name the record and are not fields; give only the fields that change, such as { done: true }`,
			);

		const { body, ...given } = patch;
		if (body !== undefined && typeof body !== 'string')
			return misfitFor(id, 'body must be text');
		const checked = splitPatch(id, given, before === undefined);
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
		const next = recordFrom(id, readMarkdown(after)).result;
		// Nothing is written: say what the change would still leave wrong, and
		// carry no record, since none was written.
		if (next.error !== null)
			return ActionError.Misfit({ path, id, problems: next.error.problems });
		return Ok({ value: next.data, text: after });
	}

	/**
	 * Write `id` as `planWrite` says, from its file now. The bytes are compared,
	 * not the text, since decoding drops a byte order mark.
	 */
	function write(id: string, need: Need, change: Patch | Compute) {
		refuseLinked();
		const before = readBytes(join(home, pathOf(id)));
		const result = planWrite(
			id,
			need,
			change,
			before && new TextDecoder().decode(before),
		);
		if (result.error !== null) return result as Err<PublicError>;
		const { value, text } = result.data;
		if (text !== undefined) {
			const bytes = new TextEncoder().encode(text);
			if (!before || !Buffer.from(before).equals(bytes))
				replaceFile(home, pathOf(id), bytes);
		}
		return Ok(value);
	}

	/** `run`'s answer, or a Misfit at the key's folder for an id that cannot be a file name. */
	async function withValidId<T>(id: string, run: () => T) {
		if (isId(id)) return run();
		return ActionError.Misfit({
			path: folder,
			id,
			problems: [
				`${JSON.stringify(id)} is not a file name: the id is the file name without .md`,
			],
		});
	}

	const handle = {
		get: (id: string) =>
			withValidId(id, () => {
				refuseLinked();
				return read(id);
			}),
		async list() {
			refuseLinked();
			return filesIn(join(home, folder))
				.flatMap((name) => idOf(name) ?? [])
				.map(read)
				.filter((each) => each.error || each.data);
		},
		create: (id: string, input: Record<string, unknown>) =>
			withValidId(id, () => write(id, 'absent', input)),
		patch: (id: string, change: Record<string, unknown>) =>
			withValidId(id, () => write(id, 'present', change)),
		edit: (id: string, change: (record: unknown) => unknown) =>
			withValidId(id, () => write(id, 'either', change)),
		delete: (id: string) =>
			withValidId(id, () => {
				refuseLinked();
				return Ok(removeFile(join(home, pathOf(id))));
			}),
	};
	return { ...def, ...handle };
}
