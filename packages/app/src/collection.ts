/**
 * A collection: a typed set of Markdown files in an app. Its `path` says which
 * files belong and where `add` writes (`path.ts`); its `fields` say what each
 * file's front matter holds. A file's fields are its front matter, and its
 * body is the text after it.
 *
 * `defineCollection` returns what it was given, plus:
 *
 * - the methods an action reads and writes through, typed by the fields
 *   (`words.get(path)`, `words.set(path, { meaning })`), over the folder of
 *   the run they are called in;
 * - `actions()`, which gives its verbs as actions to expose
 *   (`list`, `get`, `add`, `set`, `edit`, `delete`), each a thin layer over
 *   those methods.
 *
 * A record's address is its path inside the app. `add` makes a file and
 * refuses one already there; `set` changes fields of a file that exists,
 * merging as JSON Merge Patch does (a field given as `null` is removed); `edit`
 * replaces one quoted passage of the body. A one-file collection (`settings.md`)
 * has `get`, `set`, and `edit`: an absent file reads as its defaults, and its
 * first `set` makes it.
 *
 * A field marked `readOnly` is left out of the exposed `add` and `set`, so only
 * the app's own actions write it, through the methods.
 *
 * A collection does not know its name: an app names it by its key in
 * `collections`, and everything a collection says names its path instead.
 */
import {
	type Static,
	type TObject,
	type TSchema,
	type TString,
	Type,
} from 'typebox';
import { Value } from 'typebox/value';
import { type Action, type ActionMeta, RESERVED_FIELDS } from './action.ts';
import { folder } from './context.ts';
import {
	type FieldValues,
	isFieldKey,
	type JsonValue,
	markdownOf,
	readMarkdown,
	withFields,
} from './front-matter.ts';
import {
	type CreatedAt,
	type IsSingle,
	type Placeholders,
	TIME,
	type Template,
	template,
	templateProblem,
} from './path.ts';

/** A collection's fields: each a TypeBox schema, such as `field.text()`. */
export type Fields = Record<string, TSchema>;

/** What `defineCollection` takes. */
export type CollectionDef = {
	/** Its files: `words/{word}.md`, `settings.md`, or a list whose first is where `add` writes. */
	readonly path: string | readonly string[];
	/** What one file is, for the descriptions of its actions: "a word I'm learning". */
	readonly description?: string;
	readonly fields: Fields;
};

/** `T` flattened, without the `readonly` a `const` declaration gives its fields. */
type Simplify<T> = { -readonly [K in keyof T]: T[K] } & {};

type Values<F extends Fields> = Static<TObject<F>>;

type KeysWhere<F, Mark> = {
	[K in keyof F]: F[K] extends Mark ? K : never;
}[keyof F];

/** Fields only the app's own actions write. */
type ReadOnlyKeys<F> = KeysWhere<F, { readOnly: true }>;

/** Fields a file may go without, which `null` removes. */
type OptionalKeys<F> = KeysWhere<F, { '~optional': true }>;

/** The fields given to `set`: any of them, and `null` for one a file may go without. */
type Patch<F extends Fields, K extends keyof F = keyof F> = {
	-readonly [P in K]?:
		| Values<F>[P & keyof Values<F>]
		| (P extends OptionalKeys<F> ? null : never);
};

/** A row of `list`: the file's path and its fields. */
export type Row<D extends CollectionDef> = Simplify<
	{ path: string } & Values<D['fields']>
>;

/** One file as `get` reads it: its path, fields, and body. */
export type FileOf<D extends CollectionDef> = Simplify<
	{ path: string } & Values<D['fields']> & { body: string }
>;

/** The placeholders a caller fills when adding: every one in the first template but `{time}`. */
type AddKeys<D extends CollectionDef> = Exclude<
	Placeholders<CreatedAt<D['path']>>,
	typeof TIME
>;

/** What `add` takes: its placeholders, its fields, and maybe a body. */
type AddInput<D extends CollectionDef, K extends keyof D['fields']> = Simplify<
	{ [P in AddKeys<D>]: string } & Pick<
		Values<D['fields']>,
		K & keyof Values<D['fields']>
	> & { body?: string }
>;

type Writable<D extends CollectionDef> = Exclude<
	keyof D['fields'],
	ReadOnlyKeys<D['fields']>
>;

type Change = { old: string; new: string };

/** A collection of many files, as an action uses it. */
export type ManyHandle<D extends CollectionDef> = {
	/** Every file, with its path and fields, sorted by path. */
	list(): Promise<Row<D>[]>;
	/** One file, or `undefined` when there is none at `path`. */
	get(path: string): Promise<FileOf<D> | undefined>;
	/** Make a file; throws when one is already at its path. */
	add(input: AddInput<D, keyof D['fields']>): Promise<FileOf<D>>;
	/** Change the fields given; `null` removes one a file may go without. */
	set(path: string, fields: Patch<D['fields']>): Promise<FileOf<D>>;
	/** Replace the one place `old` appears in the body with `new`. */
	edit(path: string, change: Change): Promise<FileOf<D>>;
	/** Delete the file; `true` when there was one. */
	delete(path: string): Promise<boolean>;
};

/** A one-file collection, as an action uses it. */
export type SingleHandle<D extends CollectionDef> = {
	/** The file, or its defaults while there is none. */
	get(): Promise<FileOf<D>>;
	/** Change the fields given, making the file when there is none. */
	set(fields: Patch<D['fields']>): Promise<FileOf<D>>;
	edit(change: Change): Promise<FileOf<D>>;
};

/** A collection as an action uses it. */
export type Handle<D extends CollectionDef> =
	IsSingle<D['path']> extends true ? SingleHandle<D> : ManyHandle<D>;

/** The verbs a collection may expose. */
export type Verb = 'list' | 'get' | 'add' | 'set' | 'edit' | 'delete';

/** The verbs that fit a collection: all six, or `get`, `set`, `edit` for one file. */
export type VerbOf<D extends CollectionDef> =
	IsSingle<D['path']> extends true ? 'get' | 'set' | 'edit' : Verb;

type PathIn = { path: string };

/** The action verb `V` of a one-file or many-file collection gives. */
type VerbAction<D extends CollectionDef, V extends Verb> =
	IsSingle<D['path']> extends true
		? {
				get: Action<Record<string, never>, Promise<FileOf<D>>>;
				set: Action<Patch<D['fields'], Writable<D>>, Promise<FileOf<D>>>;
				edit: Action<Change, Promise<FileOf<D>>>;
				list: never;
				add: never;
				delete: never;
			}[V]
		: {
				list: Action<Record<string, never>, Promise<Row<D>[]>>;
				get: Action<PathIn, Promise<FileOf<D>>>;
				add: Action<AddInput<D, Writable<D>>, Promise<FileOf<D>>>;
				set: Action<
					Simplify<PathIn & Patch<D['fields'], Writable<D>>>,
					Promise<FileOf<D>>
				>;
				edit: Action<PathIn & Change, Promise<FileOf<D>>>;
				delete: Action<PathIn, Promise<boolean>>;
			}[V];

/** What `.actions(...)` returns: each verb's action under the verb. */
export type CollectionActions<D extends CollectionDef, V extends Verb> = {
	[P in V]: VerbAction<D, P>;
};

/** What every collection has, whatever its fields: what an app holds in `collections`. */
export type AnyCollection = CollectionDef & {
	/** Whether the file at `path` is one of this collection's. */
	holds(path: string): boolean;
	/** Each of its files whose fields do not fit, as `<path>: <what is wrong>`; inside a run. */
	misfits(): Promise<string[]>;
	actions(...verbs: never[]): Record<string, Action>;
};

/** A collection: what it was defined with, its methods, and its actions. */
export type Collection<D extends CollectionDef = CollectionDef> = Readonly<D> &
	Handle<D> &
	Pick<AnyCollection, 'holds' | 'misfits'> & {
		/** Its actions, each under its verb: every verb that fits it, or the ones named. */
		actions<V extends VerbOf<D> = VerbOf<D>>(
			...verbs: V[]
		): CollectionActions<D, V>;
	};

/**
 * Define a collection: where its files are, and what their front matter holds.
 *
 * ```ts
 * const words = defineCollection({
 *   path: 'words/{word}.md',
 *   fields: { meaning: field.text(), due: field.datetime({ optional: true, readOnly: true }) },
 * });
 * ```
 *
 * Inside a run, its methods read and write that run's folder:
 * `await words.get('words/你好.md')`. Anywhere else they throw, so loading an
 * app never touches its files. Throws when the definition is wrong in a way
 * its types cannot say.
 */
export function defineCollection<const D extends CollectionDef>(
	definition: D,
): Collection<D> {
	const problems = collectionProblems(definition);
	if (problems.length) throw new Error(problems.join('\n'));
	const templates = [definition.path].flat().map(template);
	const first = templates[0] as Template;
	const single = isSingle(templates);
	const files = createFiles(templates, definition.fields);
	const methods: Methods = single
		? {
				get: async () =>
					(await files.get(first.text)) ?? {
						path: first.text,
						...files.defaults(),
						body: '',
					},
				set: (fields: FieldValues) => files.set(first.text, fields),
				edit: (change: Change) => files.edit(first.text, change),
			}
		: {
				list: files.list,
				get: files.get,
				add: files.add,
				set: files.set,
				edit: files.edit,
				delete: files.delete,
			};
	const fit: readonly Verb[] = single ? SINGLE_VERBS : VERBS;
	return {
		...definition,
		...methods,
		holds: (path: string) => templates.some((t) => t.match(path)),
		misfits: files.misfits,
		actions: (...verbs: Verb[]) => {
			for (const verb of verbs)
				if (!fit.includes(verb))
					throw new Error(
						`${first.text} is one file, so it has no "${verb}"; it has ${fit.join(', ')}`,
					);
			const all = verbActions(definition, templates, methods);
			return Object.fromEntries(
				(verbs.length ? verbs : fit).map((verb) => [verb, all[verb]]),
			);
		},
	} as unknown as Collection<D>;
}

const VERBS: readonly Verb[] = ['list', 'get', 'add', 'set', 'edit', 'delete'];
const SINGLE_VERBS: readonly Verb[] = ['get', 'set', 'edit'];

const isSingle = (templates: readonly Template[]) =>
	templates.every((t) => t.placeholders.length === 0);

/** What is wrong with `def` beyond its types, one sentence each. */
function collectionProblems(def: CollectionDef): string[] {
	const texts = [def.path].flat();
	if (texts.length === 0) return ['A collection needs a path'];
	const wrong = texts.flatMap((text) => {
		const problem = templateProblem(text);
		return problem ? [`The collection path ${problem}`] : [];
	});
	if (wrong.length) return wrong;
	const read = texts.map(template);
	const at = `The collection at ${texts.join(' and ')}`;
	const problems: string[] = [];
	if (read.length > 1 && read.some((t) => t.placeholders.length === 0))
		problems.push(
			`${at} lists a path with no placeholder; a one-file collection has its path alone`,
		);
	const keys = new Set(read.flatMap((t) => t.placeholders));
	for (const key of Object.keys(def.fields ?? {})) {
		if (keys.has(key))
			problems.push(
				`${at} has a field "${key}", which its path gives as {${key}}; the file's name holds it`,
			);
		if (key === 'path' || key === 'body')
			problems.push(
				`${at} has a field "${key}", which is the file's ${key === 'path' ? 'address' : 'text after its front matter'}`,
			);
		if (RESERVED_FIELDS.has(key))
			problems.push(`${at} has a field "${key}", which epicenter reads itself`);
		if (!isFieldKey(key))
			problems.push(
				`${at} has a field ${JSON.stringify(key)}, which a front matter line cannot name`,
			);
	}
	return problems;
}

/** The first thing wrong with `value` against `schema`, as a sentence naming its field. */
function firstProblem(schema: TSchema, value: unknown): string | undefined {
	const [error] = Value.Errors(schema, value);
	if (!error) return undefined;
	const required = (error.params as { requiredProperties?: string[] })
		.requiredProperties;
	if (error.keyword === 'required' && required?.length)
		return `needs ${required.join(', ')}`;
	return `${error.instancePath.slice(1) || 'its fields'}: ${error.message}`;
}

const isOptional = (schema: TSchema) =>
	(schema as { '~optional'?: boolean })['~optional'] === true;
const isReadOnly = (schema: TSchema) =>
	(schema as { readOnly?: boolean }).readOnly === true;

/** `values` in the order the collection declares its fields, then the rest. */
function inDeclaredOrder(values: FieldValues, fields: Fields): FieldValues {
	const order = Object.keys(fields);
	const rank = (key: string) => order.indexOf(key) + 1 || order.length + 1;
	return Object.fromEntries(
		Object.entries(values).sort(([a], [b]) => rank(a) - rank(b)),
	);
}

/** The "Changed" refusal: the quoted passage is not in the body as it is now. */
function changed(message: string) {
	return Object.freeze({ name: 'Changed', message });
}

/** A collection's methods as `defineCollection` gives them, before its types are laid over. */
type Methods = Record<string, (...args: never[]) => Promise<unknown>>;

/**
 * A collection's files, each addressed by its path, read and written through
 * the folder of the run they are called in. A one-file collection makes its
 * file on its first `set` or `edit`.
 */
function createFiles(templates: readonly Template[], fields: Fields) {
	const first = templates[0] as Template;
	const single = isSingle(templates);
	const schema = Type.Object(fields);
	const defaultValues: FieldValues = {};
	for (const [key, field] of Object.entries(fields))
		if (Object.hasOwn(field, 'default'))
			defaultValues[key] = (field as { default: JsonValue }).default;
	/** Each field's default, fresh, for a file made without it. */
	const defaults = () => structuredClone(defaultValues);
	const kind = templates.map((t) => t.text).join(' or ');

	function own(path: string): string {
		const normal = path.replace(/^\.\//, '');
		if (templates.some((t) => t.match(normal))) return normal;
		throw new Error(`${normal} is not a file at ${kind}`);
	}

	function known(path: string, key: string) {
		if (!fields[key]) throw new Error(`${path} has no field "${key}"`);
	}

	async function read(path: string) {
		const text = await folder.read(path);
		return text === undefined ? undefined : { text, ...readMarkdown(text) };
	}

	async function getFile(path: string) {
		const found = await read(path);
		if (!found) return undefined;
		return { path, ...found.fields, body: found.body } as FileOf<CollectionDef>;
	}

	/** Split a patch into fields to set and fields to remove, refusing what does not fit. */
	function patchOf(path: string, given: Record<string, unknown>) {
		const removed: string[] = [];
		const set: FieldValues = {};
		for (const [key, value] of Object.entries(given)) {
			known(path, key);
			if (value === undefined) continue;
			if (value === null) {
				if (!isOptional(fields[key] as TSchema))
					throw new Error(`${key} is required, so it cannot be removed`);
				removed.push(key);
			} else set[key] = value as JsonValue;
		}
		if (removed.length === 0 && Object.keys(set).length === 0)
			throw new Error(`Nothing to set in ${path}: give a field`);
		const problem = firstProblem(Type.Partial(schema), set);
		if (problem) throw new Error(`${path} ${problem}`);
		return { set: inDeclaredOrder(set, fields), removed };
	}

	/** Make the file at `path` from the defaults, `given`, and `body`; throws when one is there or the fields do not fit. */
	async function make(path: string, given: FieldValues, body: string) {
		if ((await folder.read(path)) !== undefined)
			throw new Error(`${path} is already there`);
		for (const key of Object.keys(given)) known(path, key);
		const values = { ...defaults(), ...given };
		const problem = firstProblem(schema, values);
		if (problem) throw new Error(`A new ${path} ${problem}`);
		await folder.write(path, markdownOf(inDeclaredOrder(values, fields), body));
	}

	/** Change the fields of the file at `path`; a one-file collection makes it when there is none. */
	async function write(path: string, given: Record<string, unknown>) {
		const found = await read(path);
		const patch = patchOf(path, given);
		if (!found) {
			if (!single) throw new Error(`There is no ${path}`);
			await make(path, patch.set, '');
		} else {
			if (!found.writable)
				throw new Error(
					`${path} has front matter that is neither key: <JSON> lines nor YAML; fix it by hand first`,
				);
			await folder.write(
				path,
				withFields(found.text, found, patch.set, patch.removed),
			);
		}
		return (await getFile(path)) as FileOf<CollectionDef>;
	}

	async function editFile(path: string, change: Change) {
		const found = await read(path);
		if (!found) throw new Error(`There is no ${path}`);
		const { body, text } = found;
		const head = text.slice(0, text.length - body.length);
		const { old } = change;
		const at = body.indexOf(old);
		if (old === '' ? body !== '' : at < 0)
			throw changed(
				old === ''
					? `${path}'s body is no longer empty; get it again`
					: `${path}'s body does not have that text; it may have changed since it was read, so get it again`,
			);
		if (old !== '' && body.indexOf(old, at + 1) >= 0)
			throw new Error(
				`${path}'s body has that text more than once; quote more around it`,
			);
		await folder.write(
			path,
			head +
				(old === ''
					? change.new
					: body.slice(0, at) + change.new + body.slice(at + old.length)),
		);
		return (await getFile(path)) as FileOf<CollectionDef>;
	}

	async function paths() {
		const found = new Set<string>();
		for (const t of templates)
			for (const path of await folder.list(t.dir || undefined))
				if (t.match(path)) found.add(path);
		return [...found].sort();
	}

	return {
		async list() {
			const rows = [];
			for (const path of await paths()) {
				const found = await read(path);
				if (found) rows.push({ path, ...found.fields });
			}
			return rows as Row<CollectionDef>[];
		},
		async get(path: string) {
			return getFile(own(path));
		},
		async add(input: never) {
			const { body, ...rest } = input as Record<string, unknown>;
			const values: Record<string, string> = {};
			for (const key of first.placeholders) {
				if (key === TIME) continue;
				const value = rest[key];
				if (typeof value !== 'string')
					throw new Error(`Adding a ${first.text} file needs ${key}`);
				values[key] = value;
				delete rest[key];
			}
			const path = first.fill(values);
			const given = Object.fromEntries(
				Object.entries(rest).filter(([, value]) => value !== undefined),
			) as FieldValues;
			await make(path, given, typeof body === 'string' ? body : '');
			return (await getFile(path)) as FileOf<CollectionDef>;
		},
		async set(path: string, given: Record<string, unknown>) {
			return write(own(path), given);
		},
		async edit(path: string, change: Change) {
			const at = own(path);
			if (single && (await folder.read(at)) === undefined)
				await make(at, {}, '');
			return editFile(at, change);
		},
		async delete(path: string) {
			const at = own(path);
			const existed = (await folder.read(at)) !== undefined;
			await folder.delete(at);
			return existed;
		},
		defaults,
		async misfits() {
			const found: string[] = [];
			for (const path of single ? [first.text] : await paths()) {
				const text = await folder.read(path);
				if (text === undefined) continue;
				const read = readMarkdown(text);
				const problem = read.writable
					? firstProblem(schema, read.fields)
					: 'its front matter is neither key: <JSON> lines nor YAML';
				if (problem) found.push(`${path}: ${problem}`);
			}
			return found;
		},
	};
}

/** Each verb as an action to expose, described by the collection's path. */
function verbActions(
	def: CollectionDef,
	templates: readonly Template[],
	methods: Methods,
): Record<Verb, Action> {
	const call = methods as Record<string, (...args: unknown[]) => Promise<unknown>>;
	const first = templates[0] as Template;
	const single = isSingle(templates);
	const kind = templates.map((t) => t.text).join(' or ');
	const what = def.description ?? `${kind} file`;
	const writable = Object.fromEntries(
		Object.entries(def.fields).filter(([, schema]) => !isReadOnly(schema)),
	);
	const pathIn = {
		path: Type.String({ description: `Which file: ${kind}` }) as TString,
	};
	const patchIn: Record<string, TSchema> = {};
	for (const [key, schema] of Object.entries(writable)) {
		const { default: _, ...rest } = schema as TSchema & { default?: unknown };
		const described = (rest as { description?: string }).description;
		patchIn[key] = Type.Optional(
			isOptional(schema)
				? Type.Union([rest as TSchema, Type.Null()], {
						description: described
							? `${described}; null removes it`
							: 'null removes it',
					})
				: (rest as TSchema),
		);
	}
	const addKeys = first.placeholders.filter((key) => key !== TIME);
	const addIn: Record<string, TSchema> = {
		...Object.fromEntries(
			addKeys.map((key) => [
				key,
				Type.String({
					description: `a file's name for {${key}} in ${first.text}: no / or \\, and not starting with .`,
					pattern: '^[^./\\\\][^/\\\\]*$',
				}),
			]),
		),
		...writable,
		body: Type.Optional(
			Type.String({ description: 'The text after the front matter' }),
		),
	};
	const quote = {
		old: Type.String({
			description:
				'The exact text to replace, as get returned it; empty for an empty body',
		}),
		new: Type.String({ description: 'The text to put in its place' }),
	};
	const local = { openWorldHint: false } as const;
	/** Refuse a field only the app's own actions write; the runner refuses it first, this guards a direct call. */
	const outside = (input: Record<string, unknown>) => {
		for (const key of Object.keys(input))
			if (def.fields[key] && isReadOnly(def.fields[key]))
				throw new Error(`${key} is written only by the app's own actions`);
		return input;
	};
	const action = <In>(run: (input: In) => unknown, meta: ActionMeta): Action =>
		Object.assign(run, meta);
	return {
		list: action(async () => call.list?.(), {
			description: `Every ${what}: its path and fields`,
			input: {},
			annotations: { readOnlyHint: true, ...local },
		}),
		get: action(
			async (input: { path?: string }) => {
				if (single) return call.get?.();
				const found = await call.get?.(input.path);
				if (!found) throw new Error(`There is no ${input.path}`);
				return found;
			},
			{
				description: single
					? `Read ${first.text}: its fields and body, or its defaults while there is none`
					: `Read one ${what}: its fields and body`,
				input: single ? {} : pathIn,
				positional: single ? [] : ['path'],
				annotations: { readOnlyHint: true, ...local },
			},
		),
		add: action(
			async (input: Record<string, unknown>) =>
				call.add?.(outside(input)),
			{
				description: `Make a new ${what}${first.placeholders.includes(TIME) ? ', named by the time' : ''}; refused when one is already at its path`,
				input: addIn,
				positional: addKeys,
				annotations: { destructiveHint: false, ...local },
			},
		),
		set: action(
			async (input: Record<string, unknown>) => {
				const { path, ...given } = outside(input);
				return single
					? call.set?.(given)
					: call.set?.(path, given);
			},
			{
				description: single
					? `Change the fields given in ${first.text}, keeping the rest and the body; null removes a field that may be absent; makes the file when there is none`
					: `Change the fields given in one ${what}, keeping the rest and the body; null removes a field that may be absent`,
				input: single ? patchIn : { ...pathIn, ...patchIn },
				positional: single ? [] : ['path'],
				annotations: { idempotentHint: true, ...local },
			},
		),
		edit: action(
			async (input: { path?: string } & Change) =>
				single
					? call.edit?.(input)
					: call.edit?.(input.path, input),
			{
				description: `Replace one passage of ${single ? first.text : `a ${what}`}'s body: old must appear in it exactly once, or be empty for an empty body; refused otherwise, so a passage changed since it was read is never overwritten`,
				input: single ? quote : { ...pathIn, ...quote },
				positional: single ? [] : ['path'],
				annotations: local,
			},
		),
		delete: action(async (input: { path: string }) => call.delete?.(input.path), {
			description: `Delete one ${what}; true when there was one`,
			input: pathIn,
			positional: ['path'],
			annotations: { idempotentHint: true, ...local },
		}),
	};
}
