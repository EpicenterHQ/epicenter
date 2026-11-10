/**
 * A collection: a typed set of Markdown files in an app. Its `path` says which
 * files belong and where `add` writes (`path.ts`); its `fields` say what each
 * file's front matter holds. A file's fields are its front matter, and its
 * body is the text after it.
 *
 * `defineCollection` returns what it was given, plus:
 *
 * - the methods an action reads and writes through, typed by the fields
 *   (`words.get({ path })`, `words.set({ path, meaning })`), over the folder
 *   of the run they are called in;
 * - `actions()`, which gives its verbs as actions to expose
 *   (`list`, `get`, `add`, `set`, `edit`, `delete`), each a thin layer over
 *   those methods, taking the same input.
 *
 * A record's address is its path inside the app. `add` makes a file and
 * refuses one already there; `set` changes fields of a file that exists,
 * merging as JSON Merge Patch does (a field given as `null` is removed); `edit`
 * replaces one quoted passage of the body. The method `update` changes a file
 * by what is in it: it gives the record to a function and writes the patch the
 * function returns over that same record, as `folder.update` does for text, so
 * a value computed from the record is never written over a change made since.
 * A one-file collection (`settings.md`) has `get`, `set`, `edit`, and
 * `update`: an absent file reads as its defaults, and its first write makes
 * it, so each of its fields is optional or has a default.
 *
 * A read never trusts the file: each field is its value when it fits, else its
 * default, else absent, and a file that does not fit says why in `problems`.
 * `path`, the placeholders the path holds (`word` in `words/{word}.md`), and
 * `body` always come from the file itself. Front matter no field declares is
 * kept by every write, and `get` shows it in `other`.
 *
 * A field marked `readOnly` is left out of the exposed `add` and `set`, so only
 * the app's own actions write it, through the methods. When such a field is
 * required and has no default, the collection exposes no `add` at all.
 *
 * A collection whose path is `.local` (`google.local.md`) holds what stays on
 * this computer, such as a sign-in (ADR-0870). Its methods work as any
 * collection's, and a read-only action may write it; `actions()` throws, so
 * no generated verb hands its values to a caller.
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
import { folder, isLocalPath } from './context.ts';
import {
	type FieldValues,
	isFieldKey,
	type JsonValue,
	markdownOf,
	readMarkdown,
	withFields,
} from './front-matter.ts';
import {
	type IsSingle,
	type Placeholders,
	type Template,
	TIME,
	template,
	templateProblem,
} from './path.ts';

/** A collection's fields: each a TypeBox schema, such as `field.text()`. */
export type Fields = Record<string, TSchema>;

/** What `defineCollection` takes. */
export type CollectionDef = {
	/** Its files, as one template: `words/{word}.md`, or `settings.md` for one file. */
	readonly path: string;
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

/** Fields with a default, which a read always has and a write may leave out. */
type DefaultedKeys<F> = KeysWhere<F, { default: unknown }>;

/** Fields `add` could never be given: written only by the app's own actions, required, and with no default. */
type UnaddableKeys<F> = Exclude<
	ReadOnlyKeys<F>,
	OptionalKeys<F> | DefaultedKeys<F>
>;

/** The fields given to `set`: any of them, and `null` for one a file may go without. */
type Patch<F extends Fields, K extends keyof F = keyof F> = {
	-readonly [P in K]?:
		| Values<F>[P & keyof Values<F>]
		| (P extends OptionalKeys<F> ? null : never);
};

/** The fields `K` as a write gives them: one with a default may be left out. */
type WriteValues<F extends Fields, K extends keyof F> = Pick<
	Values<F>,
	Exclude<K, DefaultedKeys<F>> & keyof Values<F>
> &
	Partial<Pick<Values<F>, K & DefaultedKeys<F> & keyof Values<F>>>;

/**
 * The fields as a read gives them: each one's value if it fits, else its
 * default, else absent. So a field with a default is always there, and every
 * other field may be absent.
 */
type ReadValues<F extends Fields> = {
	-readonly [K in DefaultedKeys<F>]-?: Exclude<Static<F[K]>, undefined>;
} & {
	-readonly [K in Exclude<keyof F, DefaultedKeys<F>>]?: Exclude<
		Static<F[K]>,
		undefined
	>;
};

/** The placeholder values a read gives, from the file's path: `word` for `words/{word}.md`. */
type PlaceholderValues<P extends string> = { [K in Placeholders<P>]: string };

/** What a read says about a file that does not fit its fields: one line per problem, quoting each value it dropped. */
type Problems = { problems?: string[] };

/** A row of `list`: the file's path, its placeholders, its fields, and its problems. */
export type Row<D extends CollectionDef> = Simplify<
	{ path: string } & PlaceholderValues<D['path']> &
		ReadValues<D['fields']> &
		Problems
>;

/**
 * One file as `get` reads it: a row, its body, and `other`, the front
 * matter that is not a field's fitting value (keys no field declares, and the
 * values that did not fit), when there is any.
 */
export type FileOf<D extends CollectionDef> = Simplify<
	{ path: string } & PlaceholderValues<D['path']> &
		ReadValues<D['fields']> & { body: string } & Problems & {
			other?: Record<string, JsonValue>;
		}
>;

/** The placeholders a caller fills when adding: every one but `{time}`. */
type AddKeys<D extends CollectionDef> = Exclude<
	Placeholders<D['path']>,
	typeof TIME
>;

/** What `add` takes: its placeholders, its fields, and maybe a body. */
type AddInput<D extends CollectionDef, K extends keyof D['fields']> = Simplify<
	{ [P in AddKeys<D>]: string } & WriteValues<D['fields'], K> & {
			body?: string;
		}
>;

type Writable<D extends CollectionDef> = Exclude<
	keyof D['fields'],
	ReadOnlyKeys<D['fields']>
>;

type PathIn = { path: string };

type Change = { old: string; new: string };

/** What an `update` function returns: the fields to change, as `set` takes them, and a new body if it changes. */
type Revision<F extends Fields> = Simplify<Patch<F> & { body?: string }>;

/** The function `update` calls with the record as it is, returning what to change in it. */
type Revise<D extends CollectionDef> = (
	record: FileOf<D>,
) => Revision<D['fields']>;

/** A collection of many files, as an action uses it. */
export type ManyHandle<D extends CollectionDef> = {
	/** Every file, with its path, placeholders, and fields, sorted by path. */
	list(): Promise<Row<D>[]>;
	/** One file, or `undefined` when there is none at `path`. */
	get(at: PathIn): Promise<FileOf<D> | undefined>;
	/** Make a file; throws when one is already at its path. */
	add(input: AddInput<D, keyof D['fields']>): Promise<FileOf<D>>;
	/** Change the fields given; `null` removes one a file may go without. The last write wins: to write what you computed from the file, use `update`. */
	set(input: Simplify<PathIn & Patch<D['fields']>>): Promise<FileOf<D>>;
	/** Replace the one place `old` appears in the body with `new`. */
	edit(input: Simplify<PathIn & Change>): Promise<FileOf<D>>;
	/**
	 * Change the file at `path` by what is in it. `revise` gets the record as
	 * `get` gives it and returns what `set` takes, without `path` and with
	 * `body` if the body changes; that is written only over the record it
	 * was given. When the file changed meanwhile, `revise` runs again on what
	 * is there now, so keep it a pure function of the record; after 10
	 * seconds of that it throws `{ name: 'Changed' }`. A `revise` that throws writes nothing.
	 * Throws when there is no file at `path`. Returns the record written.
	 *
	 * ```ts
	 * await words.update({ path }, (word) => ({ reps: (word.reps ?? 0) + 1 }));
	 * ```
	 */
	update(at: PathIn, revise: Revise<D>): Promise<FileOf<D>>;
	/** Delete the file; `true` when there was one. */
	delete(at: PathIn): Promise<boolean>;
	/** The path `add` would write for these placeholder values: `pathOf({ word: '你好' })` is `words/你好.md`. */
	pathOf(
		placeholders: {
			[P in Placeholders<D['path']>]: string;
		},
	): string;
};

/** A one-file collection, as an action uses it. */
export type SingleHandle<D extends CollectionDef> = {
	/** The file, or its defaults while there is none. */
	get(): Promise<FileOf<D>>;
	/** Change the fields given, making the file when there is none. The last write wins: to write what you computed from the file, use `update`. */
	set(fields: Patch<D['fields']>): Promise<FileOf<D>>;
	edit(change: Change): Promise<FileOf<D>>;
	/** Change the file by what is in it, as a many-file collection's `update` does, making the file when there is none. */
	update(revise: Revise<D>): Promise<FileOf<D>>;
};

/** A collection as an action uses it. */
export type Handle<D extends CollectionDef> =
	IsSingle<D['path']> extends true ? SingleHandle<D> : ManyHandle<D>;

/** The verbs a collection may expose. */
export type Verb = 'list' | 'get' | 'add' | 'set' | 'edit' | 'delete';

/**
 * The verbs that fit a collection: `get`, `set`, `edit` for one file, else
 * all six, less `add` when a field `add` could never be given is required.
 */
type VerbOf<D extends CollectionDef> =
	IsSingle<D['path']> extends true
		? 'get' | 'set' | 'edit'
		: [UnaddableKeys<D['fields']>] extends [never]
			? Verb
			: Exclude<Verb, 'add'>;

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
				edit: Action<Simplify<PathIn & Change>, Promise<FileOf<D>>>;
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
	actions(...verbs: never[]): Record<string, Action>;
};

/** A collection: what it was defined with, its methods, and its actions. */
export type Collection<D extends CollectionDef = CollectionDef> = Readonly<D> &
	Handle<D> &
	Pick<AnyCollection, 'holds'> & {
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
 * `await words.get({ path: words.pathOf({ word: '你好' }) })`. Anywhere else
 * they throw, so loading an app never touches its files. Throws when the
 * definition is wrong in a way its types cannot say.
 */
export function defineCollection<const D extends CollectionDef>(
	definition: D,
): Collection<D> {
	const problems = collectionProblems(definition);
	if (problems.length) throw new Error(problems.join('\n'));
	const layout = template(definition.path);
	const single = layout.placeholders.length === 0;
	const files = createFiles(layout, definition.fields);
	const methods: Methods = single
		? {
				get: () => files.get({ path: layout.text }),
				set: (fields: Record<string, unknown>) =>
					files.set({ ...fields, path: layout.text }),
				edit: (change: Change) => files.edit({ ...change, path: layout.text }),
				update: (revise: AnyRevise) =>
					files.update({ path: layout.text }, revise),
			}
		: {
				list: files.list,
				get: files.get,
				add: files.add,
				set: files.set,
				edit: files.edit,
				update: files.update,
				delete: files.delete,
			};
	const unaddable = Object.entries(definition.fields)
		.filter(
			([, schema]) =>
				isReadOnly(schema) && !isOptional(schema) && !hasDefault(schema),
		)
		.map(([key]) => key);
	const fit: readonly Verb[] = single
		? SINGLE_VERBS
		: unaddable.length
			? VERBS.filter((verb) => verb !== 'add')
			: VERBS;
	return {
		...definition,
		...methods,
		...(single ? {} : { pathOf: files.pathOf }),
		holds: (path: string) => layout.match(path) !== undefined,
		actions: (...verbs: Verb[]) => {
			if (isLocalPath(layout.text))
				throw new Error(
					`${layout.text} never leaves this computer, so it offers no actions`,
				);
			for (const verb of verbs) {
				if (fit.includes(verb)) continue;
				if (verb === 'add' && !single)
					throw new Error(
						`${layout.text} has no "add": ${unaddable.join(', ')} ${unaddable.length === 1 ? 'is' : 'are'} written only by the app's own actions, required, and without a default, so an exposed add could never be given ${unaddable.length === 1 ? 'it' : 'them'}; write the app's own add with defineAction`,
					);
				throw new Error(
					`${layout.text} is one file, so it has no "${verb}"; it has ${fit.join(', ')}`,
				);
			}
			const all = verbActions(definition, layout, methods);
			return Object.fromEntries(
				(verbs.length ? verbs : fit).map((verb) => [verb, all[verb]]),
			);
		},
	} as unknown as Collection<D>;
}

const VERBS: readonly Verb[] = ['list', 'get', 'add', 'set', 'edit', 'delete'];
const SINGLE_VERBS: readonly Verb[] = ['get', 'set', 'edit'];

/**
 * Names neither a field nor a placeholder may have, and why: a read gives
 * `path`, `body`, `problems`, and `other` itself, and the `epicenter`
 * command reads the rest anywhere among an action's words.
 */
const RESERVED: ReadonlyMap<string, string> = new Map([
	['path', "which is the file's address"],
	['body', "which is the file's text after its front matter"],
	['problems', 'which a read uses to say what does not fit'],
	['other', 'which a read uses for front matter that is not a field'],
	...[...RESERVED_FIELDS].map(
		(name) => [name, 'which epicenter reads itself'] as const,
	),
]);

/** What is wrong with `def` beyond its types, one sentence each. */
function collectionProblems(def: CollectionDef): string[] {
	const path: unknown = def.path;
	if (Array.isArray(path))
		return [
			`A collection has one path, not a list (${path.map((text) => JSON.stringify(text)).join(', ')}); declare a second collection for a second layout`,
		];
	if (typeof path !== 'string') return ['A collection needs a path'];
	const wrong = templateProblem(path);
	if (wrong) return [`The collection path ${wrong}`];
	const keys = new Set(template(path).placeholders);
	const at = `The collection at ${path}`;
	const problems: string[] = [];
	for (const key of keys) {
		const reserved = RESERVED.get(key);
		if (reserved)
			problems.push(`${at} has the placeholder {${key}}, ${reserved}`);
	}
	const single = keys.size === 0;
	for (const [key, schema] of Object.entries(def.fields ?? {})) {
		if (keys.has(key))
			problems.push(
				`${at} has a field "${key}", which its path gives as {${key}}; the file's name holds it`,
			);
		const reserved = RESERVED.get(key);
		if (reserved) problems.push(`${at} has a field "${key}", ${reserved}`);
		if (!isFieldKey(key))
			problems.push(
				`${at} has a field ${JSON.stringify(key)}, which a front matter line cannot name`,
			);
		else if (single && !isOptional(schema) && !hasDefault(schema))
			problems.push(
				`${at} has the required field "${key}" with no default; one file reads as its defaults before its first set, so make it optional or give it a default`,
			);
	}
	return problems;
}

const isOptional = (schema: TSchema) =>
	(schema as { '~optional'?: boolean })['~optional'] === true;
const isReadOnly = (schema: TSchema) =>
	(schema as { readOnly?: boolean }).readOnly === true;
const hasDefault = (schema: TSchema) => Object.hasOwn(schema, 'default');

type Described = {
	type?: string;
	format?: string;
	pattern?: string;
	description?: string;
	minimum?: number;
	maximum?: number;
	items?: Described;
	anyOf?: { const?: unknown }[];
	enum?: unknown[];
};

const FORMATS: Record<string, string> = {
	date: 'a day',
	'date-time': 'a date and time',
	uri: 'a URL',
	email: 'an email address',
};

const TYPES: Record<string, string> = {
	string: 'text',
	number: 'a number',
	integer: 'a whole number',
	boolean: 'true or false',
	array: 'a list',
	object: 'an object',
};

/** What a field takes, as the end of "<value> is not …", or `undefined` when it cannot be said in words. */
function wanted(field: TSchema): string | undefined {
	const schema = field as Described;
	const choices =
		schema.enum ??
		(schema.anyOf?.every((choice) => 'const' in choice)
			? schema.anyOf.map((choice) => choice.const)
			: undefined);
	if (choices)
		return `one of ${choices.map((choice) => JSON.stringify(choice)).join(', ')}`;
	if (schema.pattern !== undefined) return schema.description;
	if (schema.format !== undefined) return FORMATS[schema.format];
	if (schema.type === 'array' && schema.items?.type === 'string')
		return 'a list of text';
	const kind = schema.type === undefined ? undefined : TYPES[schema.type];
	if (!kind) return kind;
	const { minimum: min, maximum: max } = schema;
	if (min !== undefined && max !== undefined)
		return `${kind} from ${min} to ${max}`;
	if (min !== undefined) return `${kind} of at least ${min}`;
	if (max !== undefined) return `${kind} of at most ${max}`;
	return kind;
}

/** The checks `wanted` says in words; another, such as `maxLength`, keeps TypeBox's message. */
const SAID = new Set([
	'type',
	'format',
	'const',
	'anyOf',
	'enum',
	'pattern',
	'minimum',
	'maximum',
]);

/** Why `value` does not fit `schema`, quoting it: `due: "next week" is not a day`. */
function misfit(key: string, schema: TSchema, value: unknown): string {
	const quoted = `${key}: ${JSON.stringify(value)}`;
	const [error] = Value.Errors(schema, value);
	const words = wanted(schema);
	if (words && (!error || SAID.has(error.keyword)))
		return `${quoted} is not ${words}`;
	return `${quoted} ${error?.message ?? 'does not fit'}`;
}

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

/** A read's front matter: its fields, its body, and whether the front matter could be read. */
type Found = { fields: FieldValues; body: string; writable: boolean };

/** What an absent one-file collection's file reads as. */
const NONE: Found = { fields: {}, body: '', writable: true };

/** An `update` function before its types are laid over. */
type AnyRevise = (record: Record<string, unknown>) => Record<string, unknown>;

/** What a write changes: the fields to set or remove, as `set` takes them, and a new body if it changes. */
type Write = { fields: Record<string, unknown>; body?: unknown };

/**
 * A collection's files, each addressed by its path, read and written through
 * the folder of the run they are called in. A one-file collection makes its
 * file on its first write.
 */
function createFiles(layout: Template, fields: Fields) {
	const single = layout.placeholders.length === 0;

	function own(path: unknown): string {
		if (typeof path !== 'string')
			throw new Error(`Which ${layout.text} file? Give its path`);
		const normal = path.replace(/^\.\//, '');
		if (layout.match(normal)) return normal;
		throw new Error(`${normal} is not a file at ${layout.text}`);
	}

	function known(path: string, key: string) {
		if (!Object.hasOwn(fields, key))
			throw new Error(`${path} has no field "${key}"`);
	}

	/**
	 * The file at `path` as a read gives it. Each field is its value if it
	 * fits, else its default, else absent; `problems` names each that did not
	 * fit or is missing, and `other` holds the front matter no field's fitting
	 * value took. `path`, the placeholders, and `body` come from the file, and
	 * no field can be named as one of them.
	 */
	function project(path: string, found: Found) {
		const values: FieldValues = {};
		const fitting = new Set<string>();
		const problems: string[] = [];
		if (!found.writable)
			problems.push('its front matter is neither key: <JSON> lines nor YAML');
		for (const [key, schema] of Object.entries(fields)) {
			const present = Object.hasOwn(found.fields, key);
			const value = found.fields[key];
			if (present && Value.Check(schema, value)) {
				values[key] = value as JsonValue;
				fitting.add(key);
				continue;
			}
			if (present) problems.push(misfit(key, schema, value));
			else if (found.writable && !isOptional(schema) && !hasDefault(schema))
				problems.push(`${key} is missing`);
			if (hasDefault(schema))
				values[key] = structuredClone(
					(schema as { default: JsonValue }).default,
				);
		}
		const other = Object.fromEntries(
			Object.entries(found.fields).filter(([key]) => !fitting.has(key)),
		);
		const placeholders = layout.match(path) ?? {};
		return {
			path,
			...placeholders,
			...values,
			problems,
			other,
			body: found.body,
		};
	}

	/** `path` as `list` gives it: no body, and no `other`. */
	function row(path: string, found: Found) {
		const { problems, other: _, body: __, ...rest } = project(path, found);
		return problems.length ? { ...rest, problems } : rest;
	}

	/** `path` as `get` gives it. */
	function file(path: string, found: Found) {
		const { problems, other, body, ...rest } = project(path, found);
		return {
			...rest,
			body,
			...(problems.length ? { problems } : {}),
			...(Object.keys(other).length ? { other } : {}),
		};
	}

	async function read(path: string) {
		const text = await folder.read(path);
		return text === undefined ? undefined : { text, ...readMarkdown(text) };
	}

	async function getFile(path: string) {
		const found = await read(path);
		if (found) return file(path, found);
		if (single) return file(path, NONE);
		return undefined;
	}

	/** Throw naming each of `values` that does not fit, one a line. */
	function refuse(path: string, values: FieldValues, whole: boolean) {
		const problems: string[] = [];
		for (const [key, schema] of Object.entries(fields)) {
			if (!Object.hasOwn(values, key)) {
				if (whole && !isOptional(schema)) problems.push(`${key} is missing`);
			} else if (!Value.Check(schema, values[key]))
				problems.push(misfit(key, schema, values[key]));
		}
		if (problems.length)
			throw new Error(
				problems.map((problem) => `${path}: ${problem}`).join('\n'),
			);
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
		refuse(path, set, false);
		return { set: inDeclaredOrder(set, fields), removed };
	}

	/** The text of a new file at `path` from the defaults, `given`, and `body`; throws when the fields do not fit. */
	function made(path: string, given: FieldValues, body: string) {
		for (const key of Object.keys(given)) known(path, key);
		const values: FieldValues = {};
		for (const [key, schema] of Object.entries(fields))
			if (hasDefault(schema))
				values[key] = structuredClone(
					(schema as { default: JsonValue }).default,
				);
		Object.assign(values, given);
		refuse(path, values, true);
		return markdownOf(inDeclaredOrder(values, fields), body);
	}

	/** `body` with the passage `change.old` replaced by `change.new`; throws "Changed" when the body no longer has it. */
	function edited(path: string, body: string, change: Change) {
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
		return old === ''
			? change.new
			: body.slice(0, at) + change.new + body.slice(at + old.length);
	}

	/**
	 * Change the file at `path` to what `revise` makes of the record there,
	 * through `folder.update`, so it is written only over the record `revise`
	 * was given. A file that is not there is refused, or, for a one-file
	 * collection, made. Each of `set`, `edit`, and `update` writes through it.
	 */
	async function rewrite(
		path: string,
		revise: (record: ReturnType<typeof file>) => Write,
	) {
		const text = await folder.update(path, (before) => {
			const found = before === undefined ? undefined : readMarkdown(before);
			if (!found && !single) throw new Error(`There is no ${path}`);
			const { fields: given, body } = revise(file(path, found ?? NONE));
			if (body !== undefined && typeof body !== 'string')
				throw new Error(`${path}: body must be text`);
			const patch = patchOf(path, given);
			const changesFields =
				patch.removed.length > 0 || Object.keys(patch.set).length > 0;
			if (before === undefined || !found)
				return made(path, patch.set, body ?? '');
			if (!changesFields && body === undefined) return before;
			if (changesFields && !found.writable)
				throw new Error(
					`${path} has front matter that is neither key: <JSON> lines nor YAML; fix it by hand first`,
				);
			const fielded = changesFields
				? withFields(before, found, patch.set, patch.removed)
				: before;
			// Every write keeps the body as the end of the text, so the front matter is what comes before it.
			return body === undefined
				? fielded
				: fielded.slice(0, fielded.length - found.body.length) + body;
		});
		return file(path, readMarkdown(text));
	}

	async function paths() {
		return (await folder.list(layout.dir || undefined)).filter(
			(path) => layout.match(path) !== undefined,
		);
	}

	/** Fill the template with `values`, refusing one that cannot name a file. */
	function fill(values: Record<string, unknown>, made: readonly string[]) {
		const filled: Record<string, string> = {};
		for (const key of made) {
			const value = values[key];
			if (typeof value !== 'string')
				throw new Error(
					`A ${layout.text} file is named by its ${key}; give it`,
				);
			filled[key] = value;
		}
		return layout.fill(filled);
	}

	return {
		async list() {
			const rows = [];
			for (const path of await paths()) {
				const found = await read(path);
				if (found) rows.push(row(path, found));
			}
			return rows;
		},
		async get({ path }: PathIn) {
			return getFile(own(path));
		},
		async add(input: Record<string, unknown>) {
			const { body, ...rest } = input;
			const named = layout.placeholders.filter((key) => key !== TIME);
			const path = fill(rest, named);
			for (const key of named) delete rest[key];
			const given = Object.fromEntries(
				Object.entries(rest).filter(([, value]) => value !== undefined),
			) as FieldValues;
			const text = await folder.update(path, (before) => {
				if (before !== undefined) throw new Error(`${path} is already there`);
				return made(path, given, typeof body === 'string' ? body : '');
			});
			return file(path, readMarkdown(text));
		},
		async set({ path, ...given }: PathIn & Record<string, unknown>) {
			const at = own(path);
			if (Object.values(given).every((value) => value === undefined))
				throw new Error(`Nothing to set in ${at}: give a field`);
			return rewrite(at, () => ({ fields: given }));
		},
		async edit({ path, ...quoted }: PathIn & Change) {
			const at = own(path);
			return rewrite(at, (record) => ({
				fields: {},
				body: edited(at, record.body, quoted),
			}));
		},
		async update({ path }: PathIn, revise: AnyRevise) {
			return rewrite(own(path), (record) => {
				const { body, ...fields } = revise(record);
				return { fields, body };
			});
		},
		async delete({ path }: PathIn) {
			const at = own(path);
			const existed = (await folder.read(at)) !== undefined;
			await folder.delete(at);
			return existed;
		},
		pathOf: (values: Record<string, unknown>) =>
			fill(values, layout.placeholders),
	};
}

/** Each verb as an action to expose, described by the collection's path. */
function verbActions(
	def: CollectionDef,
	layout: Template,
	methods: Methods,
): Record<Verb, Action> {
	const call = methods as Record<string, (input?: unknown) => Promise<unknown>>;
	const single = layout.placeholders.length === 0;
	const what = def.description ?? `${layout.text} file`;
	const writable = Object.fromEntries(
		Object.entries(def.fields).filter(([, schema]) => !isReadOnly(schema)),
	);
	const pathIn = {
		path: Type.String({ description: `Which file: ${layout.text}` }) as TString,
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
	const addKeys = layout.placeholders.filter((key) => key !== TIME);
	const addIn: Record<string, TSchema> = {
		...Object.fromEntries(
			addKeys.map((key) => [
				key,
				Type.String({
					description: `a file's name for {${key}} in ${layout.text}: no / or \\, and not starting with .`,
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
	const outside = (input: unknown) => {
		const given = (input ?? {}) as Record<string, unknown>;
		for (const key of Object.keys(given))
			if (def.fields[key] && isReadOnly(def.fields[key]))
				throw new Error(`${key} is written only by the app's own actions`);
		return given;
	};
	const action = (
		run: (input?: unknown) => unknown,
		meta: ActionMeta,
	): Action => Object.assign(async (input?: unknown) => run(input), meta);
	return {
		list: action(() => call.list?.(), {
			description: `Every ${what}: its path and fields, and the problems of one that does not fit them`,
			input: {},
			annotations: { readOnlyHint: true, ...local },
		}),
		get: action(
			async (input) => {
				if (single) return call.get?.();
				const found = await call.get?.(input);
				if (!found)
					throw new Error(`There is no ${(input as Partial<PathIn>).path}`);
				return found;
			},
			{
				description: single
					? `Read ${layout.text}: its fields and body, or its defaults while there is none`
					: `Read one ${what}: its fields and body`,
				input: single ? {} : pathIn,
				positional: single ? [] : ['path'],
				annotations: { readOnlyHint: true, ...local },
			},
		),
		add: action((input) => call.add?.(outside(input)), {
			description: `Make a new ${what}${layout.placeholders.includes(TIME) ? ', named by the time' : ''}; refused when one is already at its path`,
			input: addIn,
			positional: addKeys,
			annotations: { destructiveHint: false, ...local },
		}),
		set: action((input) => call.set?.(outside(input)), {
			description: single
				? `Change the fields given in ${layout.text}, keeping the rest and the body; null removes a field that may be absent; makes the file when there is none`
				: `Change the fields given in one ${what}, keeping the rest and the body; null removes a field that may be absent`,
			input: single ? patchIn : { ...pathIn, ...patchIn },
			positional: single ? [] : ['path'],
			annotations: { idempotentHint: true, ...local },
		}),
		edit: action((input) => call.edit?.(input), {
			description: `Replace one passage of ${single ? layout.text : `a ${what}`}'s body: old must appear in it exactly once, or be empty for an empty body; refused otherwise, so a passage changed since it was read is never overwritten`,
			input: single ? quote : { ...pathIn, ...quote },
			positional: single ? [] : ['path'],
			annotations: local,
		}),
		delete: action((input) => call.delete?.(input), {
			description: `Delete one ${what}; true when there was one`,
			input: pathIn,
			positional: ['path'],
			annotations: { idempotentHint: true, ...local },
		}),
	};
}
