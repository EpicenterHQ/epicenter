import { type TSchema, Type } from 'typebox';
import { Ok, type Result } from 'wellcrafted/result';
import { type Action, defineAction, type Flat } from './action.ts';
import type {
	AnyHandle,
	Change,
	DataDef,
	DataRecord,
	NewRecord,
} from './data.ts';
import {
	ActionError,
	type Changed,
	type ListedMisfit,
	type Misfit,
	type Missing,
} from './errors.ts';
import { field, isOptional } from './field.ts';

export type Verb = 'list' | 'get' | 'create' | 'patch' | 'edit' | 'delete';
type ActionInput<TDef extends DataDef, TVerb extends Verb> = {
	list: Record<string, never>;
	get: { id: string };
	create: Flat<{ id: string } & NewRecord<TDef['fields']>>;
	patch: Flat<{ id: string } & Change<TDef['fields']>>;
	edit: { id: string; old: string; new: string };
	delete: { id: string };
}[TVerb];
type ActionOutput<TDef extends DataDef, TVerb extends Verb> = {
	list: Result<Result<DataRecord<TDef>, ListedMisfit>[], never>;
	get: Result<DataRecord<TDef>, Misfit | Missing>;
	create: Result<DataRecord<TDef>, Misfit | Changed>;
	patch: Result<DataRecord<TDef>, Misfit | Changed | Missing>;
	edit: Result<DataRecord<TDef>, Misfit | Changed | Missing>;
	delete: Result<boolean, Misfit>;
}[TVerb];

/** Each named verb's action, retaining its input and Result types. */
export type DataActions<TDef extends DataDef, TVerb extends Verb> = {
	[V in TVerb]: Action<
		ActionInput<TDef, V>,
		Promise<ActionOutput<TDef, V>>,
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
	handle: AnyHandle,
	verbs: string[],
) {
	if (!verbs.length)
		throw new Error(`Name the action verbs for the data key ${key}`);
	return Object.fromEntries(
		verbs.map((verb) => [verb, dataAction(key, def, handle, verb as Verb)]),
	);
}

function dataAction(key: string, def: DataDef, handle: AnyHandle, verb: Verb) {
	const what = def.description;
	// Plain text: the handle refuses an id that cannot name a file, and its Misfit says why.
	const id = field.text({ description: `The name of the ${what}` });
	const hints = { openWorldHint: false } as const;
	const body = Type.Optional(
		Type.String({ description: 'The text after the front matter' }),
	);
	switch (verb) {
		case 'list':
			return defineAction({
				description: `Every ${what}: one result per file with its path, fields, and body; a file that does not fit its fields is an error beside the records`,
				input: {},
				annotations: { readOnlyHint: true, ...hints },
				run: async () => Ok(await handle.list()),
			});
		case 'get':
			return defineAction({
				description: `Read one ${what}: its fields and body; a file that does not fit its fields is an error`,
				input: { id },
				annotations: { readOnlyHint: true, ...hints },
				run: async ({ id }) => {
					const found = await handle.get(id);
					if (found.error === null && found.data === undefined)
						return ActionError.Missing({ path: handle.path(id) });
					return found;
				},
			});
		case 'create':
			return defineAction({
				description: `Make a new ${what} named by id; Changed (there) when one is already at its path, so a repeat makes no second`,
				input: { id, ...def.fields, body },
				annotations: {
					readOnlyHint: false,
					destructiveHint: false,
					// A repeat with the same id answers Changed (there) and writes nothing.
					idempotentHint: true,
					...hints,
				},
				run: ({ id, ...record }) => handle.create(id, record),
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
				description: `Change one ${what}: the fields given, keeping the rest (null removes one that may be absent), and body, which replaces the whole body. A missing ${what} answers Missing and is never made`,
				input: { id, ...patch, body },
				annotations: {
					readOnlyHint: false,
					destructiveHint: true,
					idempotentHint: true,
					...hints,
				},
				run: ({ id, ...change }) => handle.patch(id, change),
			});
		}
		case 'edit':
			return defineAction({
				description: `Replace exactly one occurrence of old in the body of one ${what} with new; Changed when old is not there or is there more than once, and Missing when the ${what} is absent. Not safe to repeat: a second call edits the result of the first`,
				input: {
					id,
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
				run: ({ id, old, new: replacement }) =>
					handle.edit<Changed | Missing>(id, (record) => {
						const path = handle.path(id);
						if (record === undefined) return ActionError.Missing({ path });
						const { body } = record;
						const at = body.indexOf(old);
						if (at < 0) return ActionError.Changed({ path, cause: 'quote' });
						if (body.indexOf(old, at + 1) >= 0)
							return ActionError.Changed({ path, cause: 'twice' });
						return Ok({
							body:
								body.slice(0, at) + replacement + body.slice(at + old.length),
						});
					}),
			});
		case 'delete':
			return defineAction({
				description: `Delete one ${what}; true when there was one`,
				input: { id },
				annotations: {
					readOnlyHint: false,
					destructiveHint: true,
					idempotentHint: true,
					...hints,
				},
				run: ({ id }) => handle.delete(id),
			});
		default:
			throw new Error(`The data key ${key} offers no action "${verb}"`);
	}
}
