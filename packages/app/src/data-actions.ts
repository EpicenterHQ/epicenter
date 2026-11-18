import { type TSchema, Type } from 'typebox';
import { Ok, type Result } from 'wellcrafted/result';
import { type Action, defineAction } from './action.ts';
import type {
	Change,
	Changed,
	DataDef,
	DataRecord,
	Flat,
	Handle,
	Input,
	Misfit,
	Missing,
	Passage,
	Unfit,
	WriteError,
} from './data.ts';
import { ActionError } from './errors.ts';
import { field, isOptional } from './field.ts';
import { timeId } from './time.ts';

type Verb = 'list' | 'get' | 'create' | 'patch' | 'edit' | 'delete';
/** A one-file key offers no list or create. */
export type Offered<TKey extends string> = TKey extends `${string}.md`
	? Exclude<Verb, 'list' | 'create'>
	: Verb;
/** The id a change sits beside: none for a one-file key. */
type IdOf<TKey extends string> = TKey extends `${string}.md`
	? unknown
	: { id: string };
type ActionInput<
	TKey extends string,
	TDef extends DataDef,
	TVerb extends Verb,
> = TVerb extends 'list'
	? Record<string, never>
	: TVerb extends 'create'
		? Flat<{ id?: string } & Input<TDef['fields']>>
		: TVerb extends 'patch'
			? Flat<IdOf<TKey> & Change<TDef['fields']>>
			: TVerb extends 'edit'
				? Flat<IdOf<TKey> & Passage>
				: TKey extends `${string}.md`
					? Record<string, never>
					: { id: string };
type ActionOutput<
	TKey extends string,
	TDef extends DataDef,
	TVerb extends Verb,
> = {
	list: Result<Result<DataRecord<TKey, TDef>, Misfit<TKey, TDef>>[], never>;
	get: Result<
		DataRecord<TKey, TDef> | (TKey extends `${string}.md` ? undefined : never),
		Misfit<TKey, TDef> | (TKey extends `${string}.md` ? never : Unfit | Missing)
	>;
	create: Result<DataRecord<TKey, TDef>, Unfit | Changed>;
	patch: Result<
		DataRecord<TKey, TDef>,
		WriteError<TKey, TDef> | (TKey extends `${string}.md` ? never : Missing)
	>;
	edit: Result<DataRecord<TKey, TDef>, WriteError<TKey, TDef> | Missing>;
	delete: Result<boolean, TKey extends `${string}.md` ? never : Unfit>;
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

/**
 * The actions for the named verbs of one data key. Each adapts a public
 * handle method; record checks and writes stay with the handle.
 */
export function dataActions(
	key: string,
	def: DataDef,
	handle: Handle,
	verbs: string[],
) {
	if (!verbs.length)
		throw new Error(`Name the action verbs for the data key ${key}`);
	return Object.fromEntries(
		verbs.map((verb) => [verb, dataAction(key, def, handle, verb as Verb)]),
	);
}

function dataAction(key: string, def: DataDef, handle: Handle, verb: Verb) {
	const keyed = 'list' in handle;
	const what = (def.description ?? `${key} file`).replace(
		/^(?:a|an|the)\s+/i,
		'',
	);
	// Text, not field.id: the handle's Misfit names the problem with the key.
	const id = field.text({ description: `The name of the ${what}` });
	const keys: Record<string, typeof id> = keyed ? { id } : {};
	const hints = { openWorldHint: false } as const;
	const body = Type.Optional(
		Type.String({ description: 'The text after the front matter' }),
	);
	const offersNo = () =>
		new Error(`The data key ${key} offers no action "${verb}"`);
	switch (verb) {
		case 'list':
			if (!keyed) throw offersNo();
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
						return ActionError.Missing({ path: handle.path(id as string) });
					return found;
				},
			});
		case 'create':
			if (!keyed) throw offersNo();
			return defineAction({
				description: `Make a new ${what}, named by id or, without one, by the moment it is made; Changed (there) when one is already at its path. A caller that may retry should send an id, so a repeat answers Changed (there) instead of making a second`,
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
					// Without an id, each call makes another record.
					idempotentHint: false,
					...hints,
				},
				run: ({ id, ...record }) => handle.create(id ?? timeId(), record),
			});
		case 'patch': {
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
				description: keyed
					? `Change one ${what}: the fields given, keeping the rest (null removes one that may be absent), and body, which replaces the whole body. A missing ${what} answers Missing and is never made`
					: `Change the ${what}: the fields given, keeping the rest (null removes one that may be absent), and body, which replaces the whole body. The file is made when it is absent`,
				input: { ...keys, ...patch, body },
				annotations: {
					readOnlyHint: false,
					destructiveHint: true,
					idempotentHint: true,
					...hints,
				},
				run: (input) => {
					// The dynamic keys schema supplies id only for folder keys.
					const { id, ...change } = input as typeof input & { id: string };
					return keyed ? handle.patch(id, change) : handle.patch(change);
				},
			});
		}
		case 'edit':
			return defineAction({
				description: `Replace exactly one occurrence of old in the body of ${keyed ? `one ${what}` : `the ${what}`} with new; Changed when old is not there or is there more than once, and Missing when the ${what} is absent. Not safe to repeat: a second call edits the result of the first`,
				input: {
					...keys,
					old: Type.String({
						minLength: 1,
						description:
							'The non-empty passage of the body to replace, exactly as get returned it',
					}),
					new: Type.String({ description: 'The text to put in its place' }),
				},
				annotations: {
					readOnlyHint: false,
					destructiveHint: true,
					idempotentHint: false,
					...hints,
				},
				run: (input) => {
					const {
						id,
						old,
						new: replacement,
					} = input as typeof input & {
						id: string;
					};
					const passage = { old, new: replacement };
					return keyed ? handle.edit(id, passage) : handle.edit(passage);
				},
			});
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
		default:
			throw offersNo();
	}
}
