import { join } from 'node:path';
import type { Static, TObject, TUnsafe } from 'typebox';
import { Ok, type Result } from 'wellcrafted/result';
import { isPlainObject, type PublicError } from './action-result.ts';
import { isName } from './app.ts';
import { type DataActions, dataActions, type Verb } from './data-actions.ts';
import { ActionError } from './errors.ts';
import { defaultIn, type OptionalKeys, refKeyOf } from './field.ts';
import { type Folder, filesIn } from './folder.ts';
import { isFieldKey, type JsonValue } from './front-matter.ts';
import { idProblem } from './id.ts';
import {
	type AnyRecord,
	type Compute,
	createMarkdownRecords,
	type Fields,
	type Fitting,
	type Loose,
} from './markdown-records.ts';

/** One folder or one file's declared Markdown fields. */
export type DataDef = { description?: string; fields: Fields };
type Spec = Record<string, DataDef>;
export type Flat<T> = { -readonly [K in keyof T]: T[K] } & {};
export type Change<TFields extends Fields> = Flat<
	{
		[K in keyof TFields]?:
			| Static<TFields[K]>
			| (K extends OptionalKeys<TFields> ? null : never);
	} & { body?: string }
>;
export type Input<TFields extends Fields> = Flat<
	Static<TObject<TFields>> & { body?: string }
>;
type Named = { path: string; id: string; body: string };
/** A flat record with its path, id, declared fields, and body. */
export type DataRecord<TDef extends DataDef> = Flat<
	Named & Fitting<TDef['fields']>
>;
export type Misfit<TDef extends DataDef> = Flat<
	Omit<Extract<ActionError, { name: 'Misfit' }>, 'id' | 'record'> & {
		id: string;
		record?: Flat<Named & Loose<TDef['fields']>>;
	}
>;
/** A change or id that does not fit: a Misfit with no record to show. */
export type Unfit = Flat<
	Omit<Extract<ActionError, { name: 'Misfit' }>, 'record'> & { record?: never }
>;
export type Changed = Extract<ActionError, { name: 'Changed' }>;
export type Missing = Extract<ActionError, { name: 'Missing' }>;
export type WriteError<TDef extends DataDef> = Misfit<TDef> | Unfit | Changed;
/** One passage of the body and the text to put in its place. */
export type Passage = { old: string; new: string };

type Handle<TDef extends DataDef> = {
	/**
	 * Read one id, or undefined when absent. Every method that takes an id
	 * uses it as the file name exactly, and refuses one that cannot be a name.
	 */
	get(
		id: string,
	): Promise<Result<DataRecord<TDef> | undefined, Misfit<TDef> | Unfit>>;
	/** One Result per directly contained record, sorted by path. */
	list(): Promise<Result<DataRecord<TDef>, Misfit<TDef>>[]>;
	/** Create one file, returning Changed (there) when it exists. */
	create(
		id: string,
		record: Input<TDef['fields']>,
	): Promise<Result<DataRecord<TDef>, Unfit | Changed>>;
	/** Patch fields and replace the body of an existing record; an absent id returns Missing. */
	patch(
		id: string,
		change: Change<TDef['fields']>,
	): Promise<Result<DataRecord<TDef>, WriteError<TDef> | Missing>>;
	/** Change one record based on what it holds now. */
	edit: {
		/**
		 * Compute a patch from a fitting record, or undefined when absent; the
		 * patch may create the file.
		 */
		<TError extends PublicError = never>(
			id: string,
			change: (
				record: DataRecord<TDef> | undefined,
			) => Result<Change<TDef['fields']>, TError>,
		): Promise<Result<DataRecord<TDef>, WriteError<TDef> | TError>>;
		/**
		 * Replace the one passage `old` of the body with `new`. Changed (quote)
		 * when it is not there, Changed (twice) when it is there more than once,
		 * and Missing when the file is absent.
		 */
		(
			id: string,
			passage: Passage,
		): Promise<Result<DataRecord<TDef>, WriteError<TDef> | Missing>>;
	};
	/** Delete one id, returning whether its file existed. */
	delete(id: string): Promise<Result<boolean, Unfit>>;
	/** The file path for this id as given, without checking it or the disk. */
	path(id: string): string;
};
/** Data metadata and reads: each key is a folder of records under `data/`. */
export type AnyData = Record<
	string,
	DataDef & Pick<Handle<DataDef>, 'get' | 'list' | 'path'>
>;

/** Markdown yields JSON values, so a handle at runtime is typed by them; `Data` keeps each field's schema. */
export type AnyHandle = Handle<{ fields: Record<string, TUnsafe<JsonValue>> }>;

/** One handle per key: its definition, its verbs, and its actions. */
export type Data<TSpec extends Spec> = {
	[K in keyof TSpec & string]: TSpec[K] &
		Handle<TSpec[K]> & {
			/** Expose only the named verbs. */
			actions<V extends Verb>(...verbs: [V, ...V[]]): DataActions<TSpec[K], V>;
		};
};

type RefTargets<TSchema> = TSchema extends {
	'x-epicenter-ref': { key: infer TKey extends string };
}
	? TKey
	: TSchema extends { items: infer TItem }
		? RefTargets<TItem>
		: TSchema extends { properties: infer TProperties }
			? {
					[K in keyof TProperties]: RefTargets<TProperties[K]>;
				}[keyof TProperties]
			: TSchema extends { anyOf: infer TChoices extends readonly unknown[] }
				? RefTargets<TChoices[number]>
				: never;
type RefKeys<TSpec> = keyof TSpec & string;
type ValidRefs<TSpec extends Spec> = {
	[K in keyof TSpec]: {
		fields: {
			[F in keyof TSpec[K]['fields']]: Exclude<
				RefTargets<TSpec[K]['fields'][F]>,
				RefKeys<TSpec>
			> extends never
				? unknown
				: `Data ref "${Exclude<RefTargets<TSpec[K]['fields'][F]>, RefKeys<TSpec>>}" must name a folder key in this defineData`;
		};
	};
};

/**
 * Declare an app's data: each key a folder of Markdown records under
 * `data/`, one file per id. Each handle reads and writes in `folder`, the
 * app's own.
 */
export function defineData<const TSpec extends Spec>(
	folder: Folder,
	spec: TSpec & ValidRefs<TSpec>,
): Data<TSpec> {
	for (const [key, { fields }] of Object.entries(spec)) {
		if (!isName(key))
			throw new Error(`The data key ${JSON.stringify(key)} must be a name`);
		JSON.stringify(fields);
		for (const [field, schema] of Object.entries(fields)) {
			// An action folds a record's fields beside its id and body, and a read gives its path.
			if (['path', 'body', 'id'].includes(field))
				throw new Error(`The data key ${key} reserves the field "${field}"`);
			if ((schema as { readOnly?: boolean }).readOnly)
				throw new Error(
					`The data key ${key} marks field "${field}" readOnly; an app offers only the verbs a caller may use`,
				);
			if (!isFieldKey(field))
				throw new Error(
					`The data key ${key} has a field ${JSON.stringify(field)} a front matter line cannot name`,
				);
			if (defaultIn(schema))
				throw new Error(
					`The data key ${key} has a default in field "${field}"; a read gives only what the file holds`,
				);
			checkRefs(schema, key, field);
		}
	}
	function checkRefs(schema: unknown, key: string, field: string) {
		if (typeof schema !== 'object' || schema === null) return;
		const target = refKeyOf(schema);
		if (target !== undefined && !Object.hasOwn(spec, target))
			throw new Error(
				`The data key ${key}'s field "${field}" refers to ${JSON.stringify(target)}, which must name a key in this defineData`,
			);
		for (const child of Object.values(schema)) checkRefs(child, key, field);
	}
	return Object.fromEntries(
		Object.entries(spec).map(([key, def]) => [
			key,
			createHandle(folder, key, def),
		]),
	) as unknown as Data<TSpec>;
}

/** The handle for one data key: its verbs, its definition, and its actions. */
function createHandle(folder: Folder, key: string, def: DataDef) {
	const base = `data/${key}`;
	const records = createMarkdownRecords({ folder, fields: def.fields });
	const pathFor = (id: string) => `${base}/${id}.md`;
	/** The path for `id` as given, or Misfit when it breaks ADR-0933's rule. */
	function place(id: string) {
		const problem = idProblem(id);
		if (!problem) return pathFor(id);
		// The id names no file, so the problem sits at the key's folder.
		const unfit = (line: string) =>
			ActionError.Misfit({ path: base, problems: [{ line, kind: problem }] });
		if (typeof id !== 'string') return unfit(problem);
		// Whitespace is invisible, so quote the id, and name the tidy form the
		// caller may send instead. The library itself never changes an id.
		const tidy = id.normalize('NFC').trim();
		const instead =
			tidy !== id && idProblem(tidy) === undefined
				? `; send ${JSON.stringify(tidy)}`
				: '';
		return unfit(`${JSON.stringify(id)}: ${problem}${instead}`);
	}
	const handle = {
		path: pathFor,
		async get(id: string) {
			const path = place(id);
			if (typeof path !== 'string') return path;
			return records.read(path);
		},
		async list() {
			const found = [];
			for (const name of await filesIn(folder.path, base)) {
				if (!name.endsWith('.md') || idProblem(name.slice(0, -3))) continue;
				const read = await records.read(`${base}/${name}`);
				if (read.error || read.data) found.push(read);
			}
			return found;
		},
		async create(id: string, input: Record<string, unknown>) {
			const path = place(id);
			if (typeof path !== 'string') return path;
			return records.write(path, 'absent', input);
		},
		async patch(id: string, change: Record<string, unknown>) {
			const path = place(id);
			if (typeof path !== 'string') return path;
			return records.write(path, 'present', change);
		},
		/** A function computes the change; `{ old, new }` is a fixed function that replaces one passage. */
		async edit(id: string, change: unknown) {
			const path = place(id);
			if (typeof path !== 'string') return path;
			const compute =
				typeof change === 'function'
					? (change as Compute)
					: replacing(path, change);
			if (typeof compute !== 'function') return compute;
			return records.write(path, 'either', compute);
		},
		async delete(id: string) {
			const path = place(id);
			if (typeof path !== 'string') return path;
			const existed = await Bun.file(join(folder.path, path)).exists();
			if (existed) await folder.delete(path);
			return Ok(existed);
		},
	} as AnyHandle;
	return {
		...def,
		...handle,
		actions: (...verbs: string[]) => dataActions(key, def, handle, verbs),
	};
}

/**
 * The change that replaces the one passage `old` of a record's body with
 * `new`, or Misfit when `passage` is not `{ old, new }` with non-empty `old`.
 */
function replacing(path: string, passage: unknown) {
	const keys = isPlainObject(passage)
		? Object.keys(passage).sort().join()
		: undefined;
	const { old, new: replacement } = (passage ?? {}) as Record<string, unknown>;
	const unfit = (line: string) =>
		ActionError.Misfit({ path, problems: [{ line, kind: line }] });
	if (
		keys !== 'new,old' ||
		typeof old !== 'string' ||
		typeof replacement !== 'string'
	)
		return unfit('edit takes a function or { old, new }, each text');
	if (old === '') return unfit('the passage to replace must be non-empty text');
	return (record: AnyRecord | undefined) => {
		if (record === undefined) return ActionError.Missing({ path });
		const { body } = record;
		const at = body.indexOf(old);
		if (at < 0) return ActionError.Changed({ path, cause: 'quote' });
		if (body.indexOf(old, at + 1) >= 0)
			return ActionError.Changed({ path, cause: 'twice' });
		return Ok({
			body: body.slice(0, at) + replacement + body.slice(at + old.length),
		});
	};
}
