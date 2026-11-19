import { join } from 'node:path';
import type { Static, TObject, TUnsafe } from 'typebox';
import { Ok, type Result } from 'wellcrafted/result';
import type { Flat } from './action.ts';
import { isPlainObject, type PublicError } from './action-result.ts';
import { isName } from './app.ts';
import { type DataActions, dataActions, type Verb } from './data-actions.ts';
import { ActionError } from './errors.ts';
import { defaultIn, type OptionalKeys, refKeyOf } from './field.ts';
import { type Folder, filesIn } from './folder.ts';
import { isFieldKey, type JsonValue } from './front-matter.ts';
import {
	createMarkdownRecords,
	type Fields,
	idOf,
	isId,
	refTargets,
} from './markdown-records.ts';

/**
 * One data key: what one of its records is, as a noun ("task", "writing
 * note"), and the declared Markdown fields of each. Its actions say the
 * description in sentences such as "Read one task".
 */
export type DataDef = { description: string; fields: Fields };
type Spec = Record<string, DataDef>;
export type Change<TFields extends Fields> = Flat<
	{
		[K in keyof TFields]?:
			| Static<TFields[K]>
			| (K extends OptionalKeys<TFields> ? null : never);
	} & { body?: string }
>;
/** What `create` takes: each declared field, and `body`. */
export type NewRecord<TFields extends Fields> = Flat<
	Static<TObject<TFields>> & { body?: string }
>;
/** A flat record with its path, id, declared fields, and body. */
export type DataRecord<TDef extends DataDef> = Flat<
	{ path: string; id: string; body: string } & Static<TObject<TDef['fields']>>
>;
/** A file or change that does not fit; a read's carries the fields that do as `record`. */
export type Misfit = Extract<ActionError, { name: 'Misfit' }>;
export type Changed = Extract<ActionError, { name: 'Changed' }>;
export type Missing = Extract<ActionError, { name: 'Missing' }>;

type Handle<TDef extends DataDef> = {
	/**
	 * Read one id, or undefined when absent. The id is the file name without
	 * `.md`; every method that takes one refuses an id Node would not give
	 * back as that file's name, and one the system refuses as a name.
	 */
	get(id: string): Promise<Result<DataRecord<TDef> | undefined, Misfit>>;
	/** One Result per `.md` file directly in the key's folder, sorted by path. */
	list(): Promise<Result<DataRecord<TDef>, Misfit>[]>;
	/** Create one file, returning Changed (there) when it exists. */
	create(
		id: string,
		record: NewRecord<TDef['fields']>,
	): Promise<Result<DataRecord<TDef>, Misfit | Changed>>;
	/** Patch fields and replace the body of an existing record; an absent id returns Missing. */
	patch(
		id: string,
		change: Change<TDef['fields']>,
	): Promise<Result<DataRecord<TDef>, Misfit | Changed | Missing>>;
	/**
	 * Compute a patch from a fitting record, or undefined when absent; the
	 * patch may create the file.
	 */
	edit<TError extends PublicError = never>(
		id: string,
		change: (
			record: DataRecord<TDef> | undefined,
		) => Result<Change<TDef['fields']>, TError>,
	): Promise<Result<DataRecord<TDef>, Misfit | Changed | TError>>;
	/** Delete one id, returning whether its file existed. */
	delete(id: string): Promise<Result<boolean, Misfit>>;
	/** The file path for this id as given, without checking it or the disk. */
	path(id: string): string;
};
/** Data metadata and reads: each key is a folder of records under `data/`. */
export type AnyData = Record<
	string,
	DataDef & Pick<Handle<DataDef>, 'get' | 'list' | 'path'>
>;

/** Markdown yields JSON values, so a handle at runtime is typed by them; `Data` keeps each field's schema. */
export type AnyHandle = Handle<{
	description: string;
	fields: Record<string, TUnsafe<JsonValue>>;
}>;

/** One handle per key: its definition, its verbs, and its actions. */
export type Data<TSpec extends Spec> = {
	[K in keyof TSpec & string]: TSpec[K] &
		Handle<TSpec[K]> & {
			/** Expose only the named verbs. */
			actions<V extends Verb>(...verbs: [V, ...V[]]): DataActions<TSpec[K], V>;
		};
};

/**
 * Declare an app's data: each key a folder of Markdown records under
 * `data/`, one file per id. Each handle reads and writes in `folder`, the
 * app's own.
 */
export function defineData<const TSpec extends Spec>(
	folder: Folder,
	spec: TSpec,
): Data<TSpec> {
	for (const [key, { description, fields }] of Object.entries(spec)) {
		if (!isName(key))
			throw new Error(
				(key as string).endsWith('.md')
					? `The data key ${JSON.stringify(key)} must be a name: every key is a folder of records now, so write ${JSON.stringify((key as string).slice(0, -3))}, give the one record a fixed id, and move data/${key} to data/${(key as string).slice(0, -3)}/<id>.md`
					: `The data key ${JSON.stringify(key)} must be a name`,
			);
		if (typeof description !== 'string' || description.trim() === '')
			throw new Error(
				`The data key ${key} needs a description: what one record is, such as "task"`,
			);
		if (!isPlainObject(fields))
			throw new Error(
				`The data key ${key} needs fields: an object of field schemas, {} for none`,
			);
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
		const walked = refTargets(schema);
		if (refsAnywhere(schema).length !== walked.length)
			throw new Error(
				`The data key ${key}'s field "${field}" holds a ref inside another shape; a ref is a field or the item of a list`,
			);
		for (const target of walked)
			if (!Object.hasOwn(spec, target))
				throw new Error(
					`The data key ${key}'s field "${field}" refers to ${JSON.stringify(target)}, which must name a key in this defineData`,
				);
	}
	return Object.fromEntries(
		Object.entries(spec).map(([key, def]) => [
			key,
			createHandle(folder, key, def),
		]),
	) as unknown as Data<TSpec>;
}

/** Every ref annotation anywhere in `schema`, however deep. */
function refsAnywhere(schema: unknown): string[] {
	if (typeof schema !== 'object' || schema === null) return [];
	const target = refKeyOf(schema);
	return [
		...(target === undefined ? [] : [target]),
		...Object.values(schema).flatMap(refsAnywhere),
	];
}

/** The handle for one data key: its verbs, its definition, and its actions. */
function createHandle(folder: Folder, key: string, def: DataDef) {
	const base = `data/${key}`;
	/** The ids of the key `of`: each `.md` file directly in its folder. */
	const idsIn = (of: string) =>
		filesIn(folder.path, `data/${of}`).flatMap((name) => idOf(name) ?? []);
	const records = createMarkdownRecords({
		folder,
		base,
		fields: def.fields,
		idsIn,
	});
	/**
	 * `run`'s answer, or a Misfit at the key's folder when Node would give the
	 * file for `id` another name. A name the folder or the system refuses
	 * throws from `run`.
	 */
	async function named<T>(id: string, run: () => Promise<T>) {
		if (isId(id)) return run();
		const why = 'is not a file name: the id is the file name without .md';
		// The id names no file, so the problem sits at the key's folder.
		return ActionError.Misfit({
			path: base,
			problems: [
				{ line: `${JSON.stringify(id)} ${why}`, kind: `the id ${why}` },
			],
		});
	}
	const handle = {
		path: records.path,
		get: (id: string) => named(id, () => records.read(id)),
		async list() {
			const found = [];
			for (const id of idsIn(key)) {
				const read = await records.read(id);
				if (read.error || read.data) found.push(read);
			}
			return found;
		},
		create: (id: string, input: Record<string, unknown>) =>
			named(id, () => records.write(id, 'absent', input)),
		patch: (id: string, change: Record<string, unknown>) =>
			named(id, () => records.write(id, 'present', change)),
		edit(id: string, change: (record: unknown) => unknown) {
			if (typeof change !== 'function')
				throw new Error(
					'edit takes a function of the record; to replace a passage of the body, call the generated edit action',
				);
			return named(id, () => records.write(id, 'either', change));
		},
		delete: (id: string) =>
			named(id, async () => {
				const path = records.path(id);
				const existed = await Bun.file(join(folder.path, path)).exists();
				if (existed) await folder.delete(path);
				return Ok(existed);
			}),
	} as AnyHandle;
	return {
		...def,
		...handle,
		actions: (...verbs: string[]) => dataActions(key, def, handle, verbs),
	};
}
