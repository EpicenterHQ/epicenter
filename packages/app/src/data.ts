import type { Static, TObject } from 'typebox';
import { Ok, type Result } from 'wellcrafted/result';
import { isName } from './app.ts';
import { folder, isLocalPath } from './context.ts';
import { ActionError } from './errors.ts';
import { defaultIn, refKeyOf } from './field.ts';
import { isFieldKey, readMarkdown } from './front-matter.ts';
import { idProblem } from './id.ts';
import {
	containsFileMarker,
	type Fields,
	type Fitting,
	type Loose,
} from './markdown-fields.ts';
import {
	type AnyRecord,
	type CallbackError,
	createMarkdownRecords,
} from './markdown-records.ts';

/** One folder or one file's declared Markdown fields. */
export type DataDef = { description?: string; fields: Fields };
type Spec = Record<string, DataDef>;
type Flat<T> = { -readonly [K in keyof T]: T[K] } & {};
type OptionalKeys<TFields> = {
	[K in keyof TFields]: TFields[K] extends { '~optional': true } ? K : never;
}[keyof TFields];
type Change<TFields extends Fields> = Flat<
	{
		[K in keyof TFields]?:
			| Static<TFields[K]>
			| (K extends OptionalKeys<TFields> ? null : never);
	} & { body?: string }
>;
type Input<TFields extends Fields> = Flat<
	Static<TObject<TFields>> & { body?: string }
>;
type Named<TKey extends string> = TKey extends `${string}.md`
	? { path: string; body: string }
	: { path: string; id: string; body: string };
/** A flat record with its path, folder id, declared fields, and body. */
export type DataRecord<TKey extends string, TDef extends DataDef> = Flat<
	Named<TKey> & Fitting<TDef['fields']>
>;
type Misfit<TKey extends string, TDef extends DataDef> = Flat<
	Omit<Extract<ActionError, { name: 'Misfit' }>, 'record'> & {
		record?: Flat<Named<TKey> & Loose<TDef['fields']>>;
	}
>;
type Refused = Extract<ActionError, { name: 'Refused' }>;
type Changed = Extract<ActionError, { name: 'Changed' }>;
type Missing = Extract<ActionError, { name: 'Missing' }>;
type WriteError<TKey extends string, TDef extends DataDef> =
	| Misfit<TKey, TDef>
	| Refused
	| Changed;
type Update<
	TKey extends string,
	TDef extends DataDef,
	TArgs extends unknown[],
> = <TError extends CallbackError = never>(
	...args: [
		...TArgs,
		change: (
			record: DataRecord<TKey, TDef> | undefined,
		) => Result<Change<TDef['fields']>, TError>,
	]
) => Promise<Result<DataRecord<TKey, TDef>, WriteError<TKey, TDef> | TError>>;

type OneFile<TKey extends string, TDef extends DataDef> = {
	/** Read this file, or undefined before it exists. */
	get(): Promise<
		Result<DataRecord<TKey, TDef> | undefined, Misfit<TKey, TDef>>
	>;
	/** Patch fields and body, creating the file when absent. */
	set(
		change: Change<TDef['fields']>,
	): Promise<Result<DataRecord<TKey, TDef>, WriteError<TKey, TDef>>>;
	/** Compute a patch from a fitting record, or undefined when absent. */
	update: Update<TKey, TDef, []>;
	/** Delete the file, returning whether it existed. */
	delete(): Promise<Result<boolean, never>>;
	/** This key's file path, without disk access. */
	pathOf(): string;
};
type FolderHandle<TKey extends string, TDef extends DataDef> = {
	/** Read one id, or undefined when absent. */
	get(
		id: string,
	): Promise<
		Result<DataRecord<TKey, TDef> | undefined, Misfit<TKey, TDef> | Refused>
	>;
	/** One Result per directly contained record, sorted by path. */
	list(): Promise<Result<DataRecord<TKey, TDef>, Misfit<TKey, TDef>>[]>;
	/** Create one file, returning Changed (there) when it exists. */
	add(
		id: string,
		record: Input<TDef['fields']>,
	): Promise<Result<DataRecord<TKey, TDef>, Refused | Changed>>;
	/** Patch an existing record; an absent id returns Missing. */
	set(
		id: string,
		change: Change<TDef['fields']>,
	): Promise<Result<DataRecord<TKey, TDef>, WriteError<TKey, TDef> | Missing>>;
	/** Compute a patch from a fitting record, or undefined when absent. */
	update: Update<TKey, TDef, [id: string]>;
	/** Delete one id, returning whether its file existed. */
	delete(id: string): Promise<Result<boolean, Refused>>;
	/** The file path for this id, without checking the id or the disk. */
	pathOf(id: string): string;
};
/** One handle per key, selected only by whether its name ends in .md. */
export type Data<TSpec extends Spec> = {
	[K in keyof TSpec & string]: TSpec[K] &
		(K extends `${string}.md`
			? OneFile<K, TSpec[K]>
			: FolderHandle<K, TSpec[K]>);
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
type RefKeys<TSpec> = Exclude<
	keyof TSpec & string,
	`${string}.md` | `${string}.local`
>;
type ValidRefs<TSpec extends Spec> = {
	[K in keyof TSpec]: {
		fields: {
			[F in keyof TSpec[K]['fields']]: Exclude<
				RefTargets<TSpec[K]['fields'][F]>,
				RefKeys<TSpec>
			> extends never
				? unknown
				: `Data ref "${Exclude<RefTargets<TSpec[K]['fields'][F]>, RefKeys<TSpec>>}" must name a non-local folder key in this defineData`;
		};
	};
};

/** Declare top-level data folders and Markdown files, with handles that use the current run's folder. */
export function defineData<const TSpec extends Spec>(
	spec: TSpec & ValidRefs<TSpec>,
): Data<TSpec> {
	for (const [key, { fields }] of Object.entries(spec)) {
		const name = key.replace(/\.md$/, '').replace(/\.local$/, '');
		if (!isName(name))
			throw new Error(
				`The data key ${JSON.stringify(key)} must be a name, optionally followed by .local and .md`,
			);
		JSON.stringify(fields);
		for (const [field, schema] of Object.entries(fields)) {
			if (['path', 'body', 'id', 'edit'].includes(field))
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
			if (containsFileMarker(schema))
				throw new Error(
					`The data key ${key} cannot keep the file input "${field}"`,
				);
			checkRefs(schema, key, field);
		}
	}
	function checkRefs(schema: unknown, key: string, field: string) {
		if (typeof schema !== 'object' || schema === null) return;
		const target = refKeyOf(schema);
		if (
			target !== undefined &&
			(!Object.hasOwn(spec, target) ||
				target.endsWith('.md') ||
				isLocalPath(target))
		)
			throw new Error(
				`The data key ${key}'s field "${field}" refers to ${JSON.stringify(target)}, which must name a non-local folder key in this defineData`,
			);
		for (const child of Object.values(schema)) checkRefs(child, key, field);
	}
	return Object.fromEntries(
		Object.entries(spec).map(([key, def]) => [key, createHandle(key, def)]),
	) as unknown as Data<TSpec>;
}

function createHandle(key: string, def: DataDef) {
	const single = key.endsWith('.md');
	const local = isLocalPath(key);
	const base = `data/${key}`;
	const records = createMarkdownRecords({
		fields: def.fields,
		local,
		keysOf: (path): Record<string, string> =>
			single ? {} : { id: path.slice(base.length + 1, -3) },
	});
	/** The path for `id`, or Refused when the id breaks ADR-0933's rule. */
	function place(id?: string) {
		if (single) return base;
		const problem = idProblem(id, local);
		return problem
			? ActionError.Refused({ message: `${key}: ${problem}` })
			: `${base}/${id}.md`;
	}
	async function get(id?: string) {
		const path = place(id);
		if (typeof path !== 'string') return path;
		const text = await folder.read(path);
		return text === undefined
			? Ok(undefined)
			: records.project(path, readMarkdown(text)).result;
	}
	function set(id: string | undefined, change: Record<string, unknown>) {
		const path = place(id);
		if (typeof path !== 'string') return Promise.resolve(path);
		const { body, ...fields } = change;
		return records.write(path, single ? 'either' : 'present', false, () =>
			Ok({ fields, body }),
		);
	}
	function update(
		id: string | undefined,
		change: (record: AnyRecord | undefined) => unknown,
	) {
		const path = place(id);
		if (typeof path !== 'string') return Promise.resolve(path);
		return records.write(
			path,
			'either',
			true,
			records.computed(change, 'update', single ? ['path'] : ['path', 'id']),
		);
	}
	async function remove(id?: string) {
		const path = place(id);
		if (typeof path !== 'string') return path;
		const existed = (await folder.read(path)) !== undefined;
		if (existed) await folder.delete(path);
		return Ok(existed);
	}
	if (single)
		return {
			...def,
			get: () => get(),
			pathOf: () => base,
			set: (change: Record<string, unknown>) => set(undefined, change),
			update: (change: (record: AnyRecord | undefined) => unknown) =>
				update(undefined, change),
			delete: () => remove(),
		};
	return {
		...def,
		get,
		pathOf: (id: string) => `${base}/${id}.md`,
		set,
		update,
		delete: remove,
		add(id: string, input: Record<string, unknown>) {
			const path = place(id);
			if (typeof path !== 'string') return Promise.resolve(path);
			const { body, ...fields } = input;
			const create = records.decide(path, 'either', false, () =>
				Ok({ fields, body }),
			);
			return folder.edit(path, (before) =>
				before === undefined
					? create(undefined)
					: ActionError.Changed({ path, why: 'there' }),
			);
		},
		async list() {
			const found: Result<
				AnyRecord,
				Extract<ActionError, { name: 'Misfit' }>
			>[] = [];
			for (const path of (await folder.list(base)).sort()) {
				if (!path.startsWith(`${base}/`) || !path.endsWith('.md')) continue;
				const id = path.slice(base.length + 1, -3);
				if (idProblem(id, local) !== undefined) continue;
				const text = await folder.read(path);
				if (text !== undefined)
					found.push(records.project(path, readMarkdown(text)).result);
			}
			return found;
		},
	};
}
