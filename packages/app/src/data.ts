import {
	type Static,
	type TObject,
	type TSchema,
	type TUnsafe,
	Type,
} from 'typebox';
import { Ok, type Result } from 'wellcrafted/result';
import { type Action, defineAction } from './action.ts';
import { isName } from './app.ts';
import { folder } from './context.ts';
import { ActionError } from './errors.ts';
import { defaultIn, field, refKeyOf } from './field.ts';
import { isFieldKey, type JsonValue, readMarkdown } from './front-matter.ts';
import { idProblem } from './id.ts';
import {
	containsFileMarker,
	type Fields,
	type Fitting,
	isOptional,
	type Loose,
} from './markdown-fields.ts';
import {
	type AnyRecord,
	type CallbackError,
	createMarkdownRecords,
} from './markdown-records.ts';
import { edited } from './text-edit.ts';
import { timeId } from './time.ts';

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
	Omit<Extract<ActionError, { name: 'Misfit' }>, 'id' | 'record'> &
		(TKey extends `${string}.md` ? unknown : { id: string }) & {
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
	/**
	 * Read one id, or undefined when absent. Every method that takes an id
	 * uses it as the file name exactly, and refuses one that cannot be a name.
	 */
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
	/** The file path for this id as given, without checking it or the disk. */
	pathOf(id: string): string;
};
/** Data metadata and reads; key names determine paths and file or folder shape. */
export type AnyData = Record<
	string,
	DataDef &
		(
			| Pick<OneFile<`${string}.md`, DataDef>, 'get' | 'pathOf'>
			| Pick<FolderHandle<string, DataDef>, 'get' | 'list' | 'pathOf'>
		)
>;

type Verb = 'list' | 'get' | 'add' | 'set' | 'delete';
type Offered<TKey extends string> = TKey extends `${string}.md`
	? 'get' | 'set' | 'delete'
	: Verb;
type IdInput<TKey extends string> = TKey extends `${string}.md`
	? Record<string, never>
	: { id: string };
type ActionInput<
	TKey extends string,
	TDef extends DataDef,
	TVerb extends Verb,
> = TVerb extends 'list'
	? Record<string, never>
	: TVerb extends 'add'
		? Flat<{ id?: string } & Input<TDef['fields']>>
		: TVerb extends 'set'
			? Flat<
					(TKey extends `${string}.md` ? unknown : { id: string }) &
						Change<TDef['fields']> & { edit?: { old: string; new: string } }
				>
			: IdInput<TKey>;
type ActionOutput<
	TKey extends string,
	TDef extends DataDef,
	TVerb extends Verb,
> = {
	list: Result<Result<DataRecord<TKey, TDef>, Misfit<TKey, TDef>>[], never>;
	get: Result<
		DataRecord<TKey, TDef> | (TKey extends `${string}.md` ? undefined : never),
		| Misfit<TKey, TDef>
		| (TKey extends `${string}.md` ? never : Refused | Missing)
	>;
	add: Result<DataRecord<TKey, TDef>, Refused | Changed>;
	set: Result<
		DataRecord<TKey, TDef>,
		WriteError<TKey, TDef> | (TKey extends `${string}.md` ? never : Missing)
	>;
	delete: Result<boolean, TKey extends `${string}.md` ? never : Refused>;
}[TVerb];

/** Each named verb's action, retaining its input and Result types. */
export type DataActions<
	TKey extends string,
	TDef extends DataDef,
	TVerb extends Verb,
> = {
	[V in TVerb]: Action<
		ActionInput<TKey, TDef, V>,
		Promise<ActionOutput<TKey, TDef, V>>,
		never
	>;
};

/** One handle per key, selected only by whether its name ends in .md. */
export type Data<TSpec extends Spec> = {
	[K in keyof TSpec & string]: TSpec[K] &
		(K extends `${string}.md`
			? OneFile<K, TSpec[K]>
			: FolderHandle<K, TSpec[K]>) & {
			/** Expose only the named verbs. */
			actions<V extends Offered<K>>(
				...verbs: [V, ...V[]]
			): DataActions<K, TSpec[K], V>;
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
type RefKeys<TSpec> = Exclude<keyof TSpec & string, `${string}.md`>;
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

/** Declare top-level data folders and Markdown files, with handles that use the current run's folder. */
export function defineData<const TSpec extends Spec>(
	spec: TSpec & ValidRefs<TSpec>,
): Data<TSpec> {
	for (const [key, { fields }] of Object.entries(spec)) {
		const name = key.replace(/\.md$/, '');
		if (!isName(name))
			throw new Error(
				`The data key ${JSON.stringify(key)} must be a name, optionally followed by .md`,
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
			(!Object.hasOwn(spec, target) || target.endsWith('.md'))
		)
			throw new Error(
				`The data key ${key}'s field "${field}" refers to ${JSON.stringify(target)}, which must name a folder key in this defineData`,
			);
		for (const child of Object.values(schema)) checkRefs(child, key, field);
	}
	return Object.fromEntries(
		Object.entries(spec).map(([key, def]) => [key, createHandle(key, def)]),
	) as unknown as Data<TSpec>;
}

function createHandle(key: string, def: DataDef) {
	// Markdown projection yields JSON values; the public generic retains each field's schema.
	const handle = createRecordHandle(key, def) as
		| OneFile<`${string}.md`, JsonDef>
		| FolderHandle<string, JsonDef>;
	return {
		...handle,
		actions(...verbs: string[]) {
			if (!verbs.length)
				throw new Error(`Name the action verbs for the data key ${key}`);
			const offered =
				'list' in handle
					? ['list', 'get', 'add', 'set', 'delete']
					: ['get', 'set', 'delete'];
			for (const verb of verbs)
				if (!offered.includes(verb))
					throw new Error(`The data key ${key} offers no action "${verb}"`);
			return Object.fromEntries(
				verbs.map((verb) => [verb, dataAction(key, def, handle, verb as Verb)]),
			);
		},
	};
}

function createRecordHandle(key: string, def: DataDef) {
	const single = key.endsWith('.md');
	const base = `data/${key}`;
	const records = createMarkdownRecords({
		fields: def.fields,
		keysOf: (path): Record<string, string> =>
			single ? {} : { id: path.slice(base.length + 1, -3) },
	});
	const pathOf = (id: string) => `${base}/${id}.md`;
	/** The path for `id` as given, or Refused when it breaks ADR-0933's rule. */
	function place(id?: string) {
		if (single) return base;
		const problem = idProblem(id);
		if (!problem) return pathOf(id as string);
		if (typeof id !== 'string')
			return ActionError.Refused({ message: `${key}: ${problem}` });
		// Whitespace is invisible, so quote the id, and name the tidy form the
		// caller may send instead. The library itself never changes an id.
		const tidy = id.normalize('NFC').trim();
		const instead =
			tidy !== id && idProblem(tidy) === undefined
				? `; send ${JSON.stringify(tidy)}`
				: '';
		return ActionError.Refused({
			message: `${key}: ${JSON.stringify(id)}: ${problem}${instead}`,
		});
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
		pathOf,
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
				if (idProblem(id) !== undefined) continue;
				const text = await folder.read(path);
				if (text !== undefined)
					found.push(records.project(path, readMarkdown(text)).result);
			}
			return found;
		},
	};
}

type JsonDef = { fields: Record<string, TUnsafe<JsonValue>> };

/** Adapt only public handle methods; record validation and writes stay with the handle. */
function dataAction(
	key: string,
	def: DataDef,
	handle: OneFile<`${string}.md`, JsonDef> | FolderHandle<string, JsonDef>,
	verb: Verb,
) {
	const keyed = 'list' in handle;
	const what = (def.description ?? `${key} file`).replace(
		/^(?:a|an|the)\s+/i,
		'',
	);
	// Text, not field.id: the handle's Refused names the problem with the key.
	const id = field.text({ description: `The name of the ${what}` });
	const keys: Record<string, typeof id> = keyed ? { id } : {};
	const hints = { openWorldHint: false } as const;
	const body = Type.Optional(
		Type.String({ description: 'The text after the front matter' }),
	);
	switch (verb) {
		case 'list':
			if (!keyed)
				throw new Error(`The data key ${key} offers no action "list"`);
			return defineAction({
				description: `Every ${what}: one result per file with its path, fields, and body; a file that does not fit its fields is an error beside the records`,
				input: {},
				annotations: { readOnlyHint: true, ...hints },
				run: async () => Ok(await handle.list()),
			});
		case 'get':
			return defineAction({
				description: `Read one ${what}: its fields and body; a file that does not fit its fields is an error`,
				input: keys,
				annotations: { readOnlyHint: true, ...hints },
				run: async ({ id }) => {
					const found = await (keyed ? handle.get(id as string) : handle.get());
					if (keyed && found.error === null && found.data === undefined)
						return ActionError.Missing({ path: handle.pathOf(id as string) });
					return found;
				},
			});
		case 'add':
			if (!keyed) throw new Error(`The data key ${key} offers no action "add"`);
			return defineAction({
				description: `Make a new ${what}, named by id or, without one, by the moment it is made; Changed (there) when one is already at its path`,
				input: {
					id: field.text({
						optional: true,
						description: `The name of the new ${what}; left out, it is named by the moment it is made`,
					}),
					...def.fields,
					body,
				},
				annotations: {
					readOnlyHint: false,
					destructiveHint: false,
					idempotentHint: true,
					...hints,
				},
				run: ({ id, ...record }) => handle.add(id ?? timeId(), record),
			});
		case 'set': {
			const patch: Record<string, TSchema> = {};
			for (const [field, schema] of Object.entries(def.fields)) {
				const { description } = schema as { description?: string };
				patch[field] = Type.Optional(
					isOptional(schema)
						? Type.Union([schema, Type.Null()], {
								description: description
									? `${description}; null removes it`
									: 'null removes it',
							})
						: schema,
				);
			}
			return defineAction({
				description: `Change one ${what} in one write: the fields given, keeping the rest (null removes one that may be absent), and body or edit. With edit, replace the one passage edit.old of the body with edit.new; fields may accompany edit, body may not`,
				input: {
					...keys,
					...patch,
					body,
					edit: Type.Optional(
						Type.Object(
							{
								old: Type.String({
									minLength: 1,
									description:
										'The non-empty passage of the body to replace, exactly as get returned it',
								}),
								new: Type.String({
									description: 'The text to put in its place',
								}),
							},
							{ additionalProperties: false },
						),
					),
				},
				annotations: {
					readOnlyHint: false,
					destructiveHint: true,
					idempotentHint: true,
					...hints,
				},
				run: async (input) => {
					// The dynamic keys schema supplies id only for folder keys.
					const { id, edit, ...change } = input as typeof input & {
						id: string;
					};
					if (edit === undefined)
						return keyed ? handle.set(id, change) : handle.set(change);
					if (change.body !== undefined)
						return ActionError.Refused({
							message: 'Give body or edit, not both',
						});
					if (edit.old === '')
						return ActionError.Refused({
							message: 'edit.old must be non-empty text',
						});
					const replace = (
						record: AnyRecord | undefined,
					): Result<Change<JsonDef['fields']>, Changed | Missing> => {
						const path = keyed ? handle.pathOf(id) : handle.pathOf();
						if (keyed && record === undefined)
							return ActionError.Missing({ path });
						const next = edited(path, record?.body ?? '', edit.old, edit.new);
						if (next.error !== null) return next;
						return Ok({ ...change, body: next.data });
					};
					return keyed
						? handle.update<Changed | Missing>(id, replace)
						: handle.update<Changed | Missing>(replace);
				},
			});
		}
		case 'delete':
			return defineAction({
				description: `Delete one ${what}; true when there was one`,
				input: keys,
				annotations: {
					readOnlyHint: false,
					destructiveHint: true,
					idempotentHint: true,
					...hints,
				},
				run: ({ id }) =>
					keyed ? handle.delete(id as string) : handle.delete(),
			});
	}
}
