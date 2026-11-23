/**
 * A home's records, opened once by its `epicenter.ts` and passed to every
 * app:
 *
 * ```ts
 * export const data = defineData(import.meta.dir, {
 *   watches: { description: 'trip idea', fields: { to: field.text() } },
 *   checks: { description: 'research result', fields: { watch: field.text() } },
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
import type { Static, TObject } from 'typebox';
import type { Result } from 'wellcrafted/result';
import type { Exists, Misfit, Missing, PublicError } from './answer.ts';
import type { Fields, Flat, OptionalKeys } from './field.ts';
import { isFieldKey } from './markdown.ts';
import { isName, NAME_RULE } from './name.ts';
import { createHandle } from './records.ts';

/**
 * One data key: what one of its records is, as a noun ("trip idea"), and
 * the front matter fields each record has.
 */
export type DataDef = { description: string; fields: Fields };
type Spec = Record<string, DataDef>;

/**
 * The error a change returns, `never` for one that only returns `Ok`. Read
 * from the whole Result, since inferring the error alone from an `Ok` falls
 * back to `PublicError`, whose name is any string.
 */
type ErrorOf<R> = R extends { error: infer E } ? Exclude<E, null> : never;

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
	edit<TChange extends Result<Change<TDef['fields']>, PublicError>>(
		id: string,
		change: (record: DataRecord<TDef> | undefined) => TChange,
	): Promise<Result<DataRecord<TDef>, Misfit | ErrorOf<TChange>>>;
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

/**
 * The records under `<dir>/data/`, one handle per key of `spec`. `dir` is
 * the home's folder, `import.meta.dir` in its `epicenter.ts`. Given what an
 * earlier call returned, it opens the same definitions under `dir`, which is
 * how a test points a home's data at a temporary folder. Throws for a key
 * or field name that cannot be a folder or a front matter line.
 */
export function defineData<const TSpec extends Spec>(
	dir: string,
	spec: TSpec,
): Data<TSpec> {
	for (const [key, { fields }] of Object.entries(spec)) {
		if (!isName(key))
			throw new Error(
				`The data key ${JSON.stringify(key)} must be ${NAME_RULE}`,
			);
		for (const name of Object.keys(fields)) {
			// A record carries its path, id and body beside its fields.
			if (['path', 'body', 'id'].includes(name))
				throw new Error(`The data key ${key} reserves the field "${name}"`);
			if (!isFieldKey(name))
				throw new Error(
					`The data key ${key} has a field ${JSON.stringify(name)} a front matter line cannot name`,
				);
		}
	}
	return Object.fromEntries(
		Object.entries(spec).map(([key, { description, fields }]) => [
			key,
			createHandle(dir, key, { description, fields }),
		]),
		// A handle at runtime reads any JSON; `Data` types it by the spec.
	) as unknown as Data<TSpec>;
}
