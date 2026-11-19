/**
 * A home's records, opened once by its `epicenter.ts` and passed to every
 * app:
 *
 * ```ts
 * export const data = defineData(import.meta.dir, {
 *   watches: { description: 'trip idea', fields: { to: field.text() } },
 *   checks: { description: 'research result', fields: { watch: field.ref('watches') } },
 * });
 * export type Data = typeof data;
 * ```
 *
 * Each key is a folder of Markdown records under the home's `data/`, one
 * file per id: `data.watches` reads and writes `data/watches/<id>.md`. A
 * handle has `list`, `get`, `create`, `patch`, `edit` and `delete`, and
 * generates no actions: an app writes each action it offers.
 *
 * `defineData` touches no file. A test rebinds the same definitions to a
 * temporary folder with `defineData(tmp, data)`.
 */
import { isAbsolute } from 'node:path';
import type { Static, TObject, TUnsafe } from 'typebox';
import { Ok, type Result } from 'wellcrafted/result';
import { deleteFile, filesIn } from './disk.ts';
import {
	ActionError,
	type Exists,
	type Misfit,
	type Missing,
	type PublicError,
} from './errors.ts';
import {
	defaultIn,
	type Fields,
	type Flat,
	type OptionalKeys,
	refKeyOf,
} from './field.ts';
import { isFieldKey, type JsonValue } from './markdown.ts';
import { isName } from './name.ts';
import { createMarkdownRecords, idOf, isId, refTargets } from './records.ts';

/**
 * One data key: what one of its records is, as a noun ("trip idea"), and
 * the front matter fields each record has.
 */
export type DataDef = { description: string; fields: Fields };
type Spec = Record<string, DataDef>;

/** What `patch` and `edit` take: each field to set, `null` to remove an optional one, and `body`. */
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
/** A record: its path from the home, its id, its fields and its body. */
export type DataRecord<TDef extends DataDef> = Flat<
	{ path: string; id: string; body: string } & Static<TObject<TDef['fields']>>
>;

/** The calls on one data key. */
export type Handle<TDef extends DataDef> = {
	/**
	 * One record, or undefined when there is no file. The id is the file name
	 * without `.md`; every call that takes one refuses with Misfit an id that
	 * cannot be a file name, such as `a/b`.
	 */
	get(id: string): Promise<Result<DataRecord<TDef> | undefined, Misfit>>;
	/** One Result per `.md` file directly in the key's folder, sorted by id. */
	list(): Promise<Result<DataRecord<TDef>, Misfit>[]>;
	/** Write a new record, refusing with Exists when one is there. */
	create(
		id: string,
		record: NewRecord<TDef['fields']>,
	): Promise<Result<DataRecord<TDef>, Misfit | Exists>>;
	/** Change fields or the body of a record, refusing with Missing when there is none. */
	patch(
		id: string,
		change: Change<TDef['fields']>,
	): Promise<Result<DataRecord<TDef>, Misfit | Missing>>;
	/**
	 * Compute a change from the record, or from undefined when there is none,
	 * in which case the change creates it. Nothing else in this process
	 * changes the file between the read and the write. `change` runs once,
	 * and returns `Ok(change)` or its own `Err`, which writes nothing.
	 */
	edit<TError extends PublicError = never>(
		id: string,
		change: (
			record: DataRecord<TDef> | undefined,
		) => Result<Change<TDef['fields']>, TError>,
	): Promise<Result<DataRecord<TDef>, Misfit | TError>>;
	/** Delete a record, answering whether there was one. */
	delete(id: string): Promise<Result<boolean, Misfit>>;
};

/**
 * One handle per key, each carrying its definition, so a result is itself a
 * spec: `defineData(tmp, data)` opens the same keys under `tmp`, with the
 * same type.
 */
export type Data<TSpec extends Spec> = {
	[K in keyof TSpec & string]: TSpec[K] & Handle<TSpec[K]>;
};

/** Markdown yields JSON values, so a handle at runtime is typed by them. */
type AnyHandle = Handle<{
	description: string;
	fields: Record<string, TUnsafe<JsonValue>>;
}>;

/**
 * The records under `<dir>/data/`, one handle per key of `spec`. `dir` is
 * the home's folder, `import.meta.dir` in its `epicenter.ts`. Given what an
 * earlier call returned, it opens the same definitions under `dir`, which is
 * how a test points a home's data at a temporary folder. Throws when a
 * definition is wrong in a way its types cannot say.
 */
export function defineData<const TSpec extends Spec>(
	dir: string,
	spec: TSpec,
): Data<TSpec> {
	if (!isAbsolute(dir))
		throw new Error(
			`defineData takes the home's folder first, as an absolute path: defineData(import.meta.dir, { ... }), not ${JSON.stringify(dir)}`,
		);
	for (const [key, { description, fields }] of Object.entries(spec)) {
		if (!isName(key))
			throw new Error(
				`The data key ${JSON.stringify(key)} must be lowercase letters, digits and dashes, starting with a letter`,
			);
		if (description.trim() === '')
			throw new Error(
				`The data key ${key} needs a description: what one record is, such as "trip idea"`,
			);
		for (const [name, schema] of Object.entries(fields)) {
			// A record carries its path, id and body beside its fields.
			if (['path', 'body', 'id'].includes(name))
				throw new Error(`The data key ${key} reserves the field "${name}"`);
			if (!isFieldKey(name))
				throw new Error(
					`The data key ${key} has a field ${JSON.stringify(name)} a front matter line cannot name`,
				);
			if (defaultIn(schema))
				throw new Error(
					`The data key ${key} has a default in field "${name}"; a read gives only what the file holds`,
				);
			const targets = refTargets(schema);
			if (refsAnywhere(schema).length !== targets.length)
				throw new Error(
					`The data key ${key}'s field "${name}" holds a ref inside another shape; a ref is a field or the item of a list`,
				);
			for (const target of targets)
				if (!Object.hasOwn(spec, target))
					throw new Error(
						`The data key ${key}'s field "${name}" refers to ${JSON.stringify(target)}, which must be a key in this defineData`,
					);
		}
	}
	return Object.fromEntries(
		Object.entries(spec).map(([key, { description, fields }]) => [
			key,
			createHandle(dir, key, { description, fields }),
		]),
	) as Data<TSpec>;
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

/** The handle for one data key: its definition and its calls. */
function createHandle(dir: string, key: string, def: DataDef) {
	const base = `data/${key}`;
	/** The ids of the key `of`: each `.md` file directly in its folder. */
	const idsIn = (of: string) =>
		filesIn(dir, `data/${of}`).flatMap((name) => idOf(name) ?? []);
	const records = createMarkdownRecords({
		home: dir,
		base,
		fields: def.fields,
		idsIn,
	});
	/** `run`'s answer, or a Misfit at the key's folder for an id that cannot be a file name. */
	async function named<T>(id: string, run: () => Promise<T>) {
		if (isId(id)) return run();
		const why = 'is not a file name: the id is the file name without .md';
		return ActionError.Misfit({
			path: base,
			id,
			problems: [
				{ line: `${JSON.stringify(id)} ${why}`, kind: `the id ${why}` },
			],
		});
	}
	const handle = {
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
		edit: (id: string, change: (record: unknown) => unknown) =>
			named(id, () => records.write(id, 'either', change)),
		delete: (id: string) =>
			named(id, async () => Ok(await deleteFile(dir, records.path(id)))),
	} as AnyHandle;
	return { ...def, ...handle };
}
