/**
 * A collection: a typed set of Markdown files in an app. Its `path` says which
 * files belong and where `add` writes (`path.ts`); its `fields` say what each
 * file's front matter holds. A file's fields are its front matter, and its
 * body is the text after it.
 *
 * `defineCollection` returns what it was given, plus:
 *
 * - the methods an action reads and writes through, typed by the fields
 *   (`words.get({ word })`, `words.set({ word }, { meaning })`), over the
 *   folder of the run they are called in;
 * - `actions()`, which gives its verbs as actions to expose
 *   (`list`, `get`, `add`, `set`, `edit`, `delete`), each a thin layer over
 *   those methods.
 *
 * A method names a record by its keys, each placeholder's value
 * (`{ word }` for `data/words/{word}.md`), and reads only those names, so a
 * row or a record can be passed as the keys. A collection with no
 * placeholder (`data/settings.md`) has the same methods without the keys.
 *
 * The writers differ by what they need of the file. `add` makes a file and
 * refuses one already there. `set` changes fields of a file that exists,
 * merging as JSON Merge Patch does (a field given as `null` is removed);
 * given a function, it writes what the function makes of the record. `edit`
 * replaces one quoted passage of the body of a file that exists. `update`
 * changes a file by what is in it, or makes it: it gives the record, or
 * `undefined`, to a function and writes what it returns over that same
 * record, as `folder.update` does for text, so a value computed from the
 * record is never written over a change made since. `set` and `edit` throw
 * `ActionError.Missing` when there is no file; a file whose front matter
 * cannot be read is refused by every writer, and by `get`.
 *
 * A read never trusts the file: each field is its value when it fits, else its
 * default, else absent, and a file that does not fit says why in `problems`.
 * `path`, the keys, and `body` always come from the file itself. Front matter
 * no field declares is kept by every write, and nothing reports it.
 *
 * A field marked `readOnly` is left out of the exposed `add` and `set`, so only
 * the app's own actions write it, through the methods. When such a field is
 * required and has no default, the collection exposes no `add` at all.
 *
 * A collection whose path is `.local` (`data/google.local.md`) holds what stays on
 * this computer, such as a sign-in (ADR-0870). Its methods work as any
 * collection's, and a read-only action may write it; `actions()` throws, so
 * no generated verb hands its values to a caller.
 *
 * A collection does not know its name: an app names it by its key in
 * `collections`, and everything a collection says names its path instead.
 */

import { type Static, type TObject, type TSchema, Type } from 'typebox';
import { Value } from 'typebox/value';
import { type Action, type ActionMeta, RESERVED_FIELDS } from './action.ts';
import { folder, isLocalPath } from './context.ts';
import { ActionError } from './errors.ts';
import { refPathOf, whatFits } from './field.ts';
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
	/** Its files, as one template: `data/words/{word}.md`, or `data/settings.md` for one file. */
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

/**
 * A record's keys: each placeholder's value, named as the path names it.
 * `{ word }` for `data/words/{word}.md`; none for `data/settings.md`.
 */
export type Keys<D extends CollectionDef> = {
	[K in Placeholders<D['path']>]: string;
};

/** The keys a method takes before anything else: none for a collection with no placeholder. */
type KeysArg<D extends CollectionDef> =
	IsSingle<D['path']> extends true ? [] : [keys: Keys<D>];

/** What a read says about a file that does not fit its fields: one line per problem, quoting each value it dropped unless the file is `.local`. */
type Problems = { problems?: string[] };

/** A row of `list`: the file's path, its keys, its fields, and its problems. */
export type Row<D extends CollectionDef> = Simplify<
	{ path: string } & Keys<D> & ReadValues<D['fields']> & Problems
>;

/** One record as `get` reads it: a row and its body. */
export type RecordOf<D extends CollectionDef> = Simplify<
	{ path: string } & Keys<D> &
		ReadValues<D['fields']> & { body: string } & Problems
>;

/** The keys a caller gives when adding: every one but `{time}`, which `add` makes. */
type AddKeys<D extends CollectionDef> = Exclude<
	Placeholders<D['path']>,
	typeof TIME
>;

/** What `add` takes: the whole new record, its keys, its fields, and maybe a body. */
type AddInput<D extends CollectionDef, K extends keyof D['fields']> = Simplify<
	{ [P in AddKeys<D>]: string } & WriteValues<D['fields'], K> & {
			body?: string;
		}
>;

type Writable<D extends CollectionDef> = Exclude<
	keyof D['fields'],
	ReadOnlyKeys<D['fields']>
>;

type Change = { old: string; new: string };

/** What `set` takes after the keys: the fields to change, or a function of the record that returns them. */
type SetChange<D extends CollectionDef> =
	| Patch<D['fields']>
	| ((record: RecordOf<D>) => Patch<D['fields']>);

/** What an `update` function returns: the fields to change, as `set` takes them, and a new body if it changes. */
type Revision<F extends Fields> = Simplify<Patch<F> & { body?: string }>;

/**
 * The function `update` calls with the record as it is, or `undefined` when
 * there is no file, returning what to change in it; when there was no file,
 * what it returns is the whole new record.
 */
type Revise<D extends CollectionDef> = (
	record: RecordOf<D> | undefined,
) => Revision<D['fields']>;

/** A collection's methods, as an action uses them. */
export type Handle<D extends CollectionDef> = {
	/** Every record, with its path, keys, and fields, sorted by path. */
	list(): Promise<Row<D>[]>;
	/** The record the keys name, or `undefined` when there is no file. */
	get(...keys: KeysArg<D>): Promise<RecordOf<D> | undefined>;
	/** Make a file from the whole new record; throws when one is already at its path. */
	add(record: AddInput<D, keyof D['fields']>): Promise<RecordOf<D>>;
	/**
	 * Change the fields given; `null` removes one a file may go without. Given
	 * a function, write the fields it returns for the record as it is, only
	 * over that record, as `update` does. Throws `ActionError.Missing` when
	 * there is no file.
	 *
	 * ```ts
	 * await words.set({ word }, { meaning });
	 * await words.set({ word }, (now) => ({ reps: (now.reps ?? 0) + 1 }));
	 * ```
	 */
	set(...args: [...KeysArg<D>, change: SetChange<D>]): Promise<RecordOf<D>>;
	/** Replace the one place `old` appears in the body with `new`; throws `ActionError.Missing` when there is no file. */
	edit(...args: [...KeysArg<D>, change: Change]): Promise<RecordOf<D>>;
	/**
	 * Change the file by what is in it, or make it. `change` gets the record
	 * as `get` gives it, `undefined` when there is no file, and returns what
	 * `set` takes, with `body` if the body changes; that is written only over
	 * the record it was given, and makes the file, as `add` would, when there
	 * was none. When the file changed meanwhile, `change` runs again on what
	 * is there now, so keep it a pure function of the record; after 10 tries it
	 * throws `ActionError.Changed`. A `change` that throws writes nothing, and
	 * one that returns `{}` for a file leaves it as it is. Returns the record
	 * written.
	 *
	 * ```ts
	 * await words.update({ word }, (now) => ({ reps: (now?.reps ?? 0) + 1 }));
	 * ```
	 */
	update(...args: [...KeysArg<D>, change: Revise<D>]): Promise<RecordOf<D>>;
	/** Delete the file; `true` when there was one. */
	delete(...keys: KeysArg<D>): Promise<boolean>;
	/** The path of the record the keys name: `pathOf({ word: '你好' })` is `data/words/你好.md`. */
	pathOf(...keys: KeysArg<D>): string;
};

/** The verbs a collection may expose. */
export type Verb = 'list' | 'get' | 'add' | 'set' | 'edit' | 'delete';

/** The verbs that fit a collection: all six, less `add` when a field `add` could never be given is required. */
type VerbOf<D extends CollectionDef> = [UnaddableKeys<D['fields']>] extends [
	never,
]
	? Verb
	: Exclude<Verb, 'add'>;

/** The input of `get` and `delete`: the keys alone, and nothing for a collection with no placeholder. */
type KeysIn<D extends CollectionDef> =
	IsSingle<D['path']> extends true ? Record<string, never> : Keys<D>;

/** The action verb `V` gives: its keys flat beside the rest of its input. */
type VerbAction<D extends CollectionDef, V extends Verb> = {
	list: Action<Record<string, never>, Promise<Row<D>[]>, never>;
	get: Action<KeysIn<D>, Promise<RecordOf<D>>, never>;
	add: Action<AddInput<D, Writable<D>>, Promise<RecordOf<D>>, never>;
	set: Action<
		Simplify<Keys<D> & Patch<D['fields'], Writable<D>>>,
		Promise<RecordOf<D>>,
		never
	>;
	edit: Action<Simplify<Keys<D> & Change>, Promise<RecordOf<D>>, never>;
	delete: Action<KeysIn<D>, Promise<boolean>, never>;
}[V];

/** What `.actions(...)` returns: each verb's action under the verb. */
export type CollectionActions<D extends CollectionDef, V extends Verb> = {
	[P in V]: VerbAction<D, P>;
};

/**
 * One problem of a file that does not fit its fields: the `line` a read's
 * `problems` gives, and its `kind`, the line without the value it quotes, so
 * one problem on many files reads alike. `due: "next week" is not a day like
 * 2026-11-12` is of the kind `due is not a day like 2026-11-12`, which is how
 * a `.local` file's line reads already.
 */
export type Problem = { line: string; kind: string };

/** What every collection has, whatever its fields: what an app holds in `collections`. */
export type AnyCollection = CollectionDef & {
	/**
	 * Read every file, for a report of what does not fit: how many files
	 * there are, and each file with problems, sorted by path. Each file's
	 * problems are the ones its read gives.
	 */
	check(): Promise<{
		files: number;
		records: { path: string; problems: Problem[] }[];
	}>;
	actions(...verbs: never[]): Record<string, Action>;
};

/** Whether `value` is what `defineCollection` returns: a path, fields, and the `check` and `actions` an app reads. */
export function isCollection(value: unknown): value is AnyCollection {
	if (typeof value !== 'object' || value === null) return false;
	const { path, fields, check, actions } = value as Partial<AnyCollection>;
	return (
		typeof path === 'string' &&
		typeof fields === 'object' &&
		typeof check === 'function' &&
		typeof actions === 'function'
	);
}

/** A collection: what it was defined with, its methods, and its actions. */
export type Collection<D extends CollectionDef = CollectionDef> = Readonly<D> &
	Handle<D> &
	Pick<AnyCollection, 'check'> & {
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
 *   path: 'data/words/{word}.md',
 *   fields: { meaning: field.text(), due: field.datetime({ optional: true, readOnly: true }) },
 * });
 * ```
 *
 * Inside a run, its methods read and write that run's folder:
 * `await words.get({ word: '你好' })`. Anywhere else they throw, so loading
 * an app never touches its files. Throws when the definition is wrong in a
 * way its types cannot say.
 */
export function defineCollection<const D extends CollectionDef>(
	definition: D,
): Collection<D> {
	const problems = collectionProblems(definition);
	if (problems.length) throw new Error(problems.join('\n'));
	// Collection fields must be publishable as JSON, independently of action policy.
	JSON.stringify(definition.fields);
	const layout = template(definition.path);
	const records = createRecords(layout, definition.fields);
	const keyed = layout.placeholders.length > 0;
	/**
	 * A method as the collection gives it. One with no placeholder takes no
	 * keys: it is given none, and refuses an argument it does not take.
	 */
	const named =
		(
			method: (keys: object, ...rest: never[]) => Promise<unknown>,
			takes: number,
		) =>
		(...args: unknown[]) => {
			const call = method as (...args: unknown[]) => Promise<unknown>;
			if (keyed) return call(...args);
			if (args.length > takes)
				return Promise.reject(
					new Error(
						`${layout.text} has no key, so name none: it is the one file`,
					),
				);
			return call({}, ...args);
		};
	const unaddable = Object.entries(definition.fields)
		.filter(
			([, schema]) =>
				isReadOnly(schema) && !isOptional(schema) && !hasDefault(schema),
		)
		.map(([key]) => key);
	const fit = unaddable.length ? VERBS.filter((verb) => verb !== 'add') : VERBS;
	return {
		...definition,
		list: records.list,
		add: records.add,
		get: named(records.get, 0),
		set: named(records.set, 1),
		edit: named(records.edit, 1),
		update: named(records.update, 1),
		delete: named(records.delete, 0),
		pathOf: keyed ? records.pathOf : () => layout.text,
		check: records.check,
		actions: (...verbs: Verb[]) => {
			if (isLocalPath(layout.text))
				throw new Error(
					`${layout.text} never leaves this computer, so it offers no actions`,
				);
			for (const verb of verbs) {
				if (fit.includes(verb)) continue;
				if (verb === 'add')
					throw new Error(
						`${layout.text} has no "add": ${unaddable.join(', ')} ${unaddable.length === 1 ? 'is' : 'are'} written only by the app's own actions, required, and without a default, so an exposed add could never be given ${unaddable.length === 1 ? 'it' : 'them'}; write the app's own add with defineAction`,
					);
				throw new Error(
					`${layout.text} has no "${verb}"; it has ${fit.join(', ')}`,
				);
			}
			const all = verbActions(definition, layout, records);
			return Object.fromEntries(
				(verbs.length ? verbs : fit).map((verb) => [verb, all[verb]]),
			);
		},
	} as unknown as Collection<D>;
}

const VERBS: readonly Verb[] = ['list', 'get', 'add', 'set', 'edit', 'delete'];

/**
 * Names neither a field nor a placeholder may have, and why: a read gives
 * `path`, `body`, and `problems` itself, and the `epicenter` command reads
 * the rest anywhere among an action's words.
 */
const RESERVED: ReadonlyMap<string, string> = new Map([
	['path', "which is the file's address"],
	['body', "which is the file's text after its front matter"],
	['problems', 'which a read uses to say what does not fit'],
	...[...RESERVED_FIELDS].map(
		(name) => [name, 'which epicenter reads itself'] as const,
	),
]);

/** Names a placeholder may not have because `edit` takes them beside the keys. */
const EDIT_INPUT = new Set(['old', 'new']);

function containsFileMarker(
	value: unknown,
	seen = new WeakSet<object>(),
): boolean {
	if (!value || typeof value !== 'object' || seen.has(value)) return false;
	seen.add(value);
	return (
		Object.hasOwn(value, 'x-epicenter-file') ||
		Object.values(value).some((child) => containsFileMarker(child, seen))
	);
}

/** What is wrong with `def` beyond its types, one sentence each. */
function collectionProblems(def: CollectionDef): string[] {
	const path: unknown = def.path;
	if (Array.isArray(path))
		return [
			`A collection has one path, not a list (${path.map((text) => JSON.stringify(text)).join(', ')}); declare a second collection for a second layout`,
		];
	if (typeof path !== 'string') return ['A collection needs a path'];
	if (!path.startsWith('data/'))
		return [
			`The collection path ${JSON.stringify(path)} must start with data/: data/${path}`,
		];
	const wrong = templateProblem(path);
	if (wrong) return [`The collection path ${wrong}`];
	const keys = new Set(template(path).placeholders);
	const at = `The collection at ${path}`;
	const problems: string[] = [];
	for (const key of keys) {
		const reserved =
			RESERVED.get(key) ??
			(EDIT_INPUT.has(key) ? 'which edit takes beside the keys' : undefined);
		if (reserved)
			problems.push(`${at} has the placeholder {${key}}, ${reserved}`);
	}
	for (const [key, schema] of Object.entries(def.fields ?? {})) {
		if (containsFileMarker(schema))
			problems.push(
				`${at} has the file field "${key}", which a collection of one file per record cannot keep; it would store the host's temporary upload reference`,
			);
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
	}
	return problems;
}

const isOptional = (schema: TSchema) =>
	(schema as { '~optional'?: boolean })['~optional'] === true;
const isReadOnly = (schema: TSchema) =>
	(schema as { readOnly?: boolean }).readOnly === true;
const hasDefault = (schema: TSchema) => Object.hasOwn(schema, 'default');

/**
 * A field and its value as a refusal names them: `due: "next week"`. A
 * `.local` file's value is not quoted (`refreshToken`), so a problem or a
 * refused write cannot carry a secret to whoever reads the message.
 */
function quote(key: string, value: unknown, local: boolean): string {
	return local ? key : `${key}: ${JSON.stringify(value)}`;
}

/** Why `value` does not fit `schema`, quoted: `due: "next week" is not a day like 2026-11-12`. */
function misfit(
	key: string,
	schema: TSchema,
	value: unknown,
	local: boolean,
): string {
	const quoted = quote(key, value, local);
	const words = whatFits(schema, value);
	if (words) return `${quoted} is not ${words}`;
	const [error] = Value.Errors(schema, value);
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

/** What a read says of front matter it cannot read. */
const UNREADABLE =
	'its front matter is not key: <JSON> lines or YAML between two --- lines';

/** A read's front matter: its fields, its body, and whether the front matter could be read. */
type Found = ReturnType<typeof readMarkdown>;

/** A record as a read gives it, before its types are laid over. */
type AnyRecord = Record<string, unknown> & { path: string; body: string };

/** What a write changes: the fields to set or remove, as `set` takes them, and a new body if it changes. */
type Write = { fields: Record<string, unknown>; body?: unknown };

/** What a writer needs of the file before it writes: that it is not there, that it is, or either. */
type Need = 'absent' | 'present' | 'either';

/** A collection's records, each named by its keys, read and written through the folder of the run they are called in. */
type Records = ReturnType<typeof createRecords>;

function createRecords(layout: Template, fields: Fields) {
	const local = isLocalPath(layout.text);

	/**
	 * The path of the record `keys` name: each placeholder's value from
	 * `keys`, and nothing else from it, as NFC, trimmed, and with single spaces.
	 */
	function pathOf(keys: object): string {
		const given = keys as Record<string, unknown>;
		const values: Record<string, string> = {};
		for (const key of layout.placeholders) {
			const value = given[key];
			if (typeof value !== 'string')
				throw new Error(
					Object.hasOwn(given, 'path')
						? `Name a ${layout.text} record by its ${layout.placeholders.join(' and ')}, not its path`
						: `A ${layout.text} record is named by its ${key}; give it`,
				);
			values[key] = value;
		}
		return layout.fill(values);
	}

	function known(path: string, key: string) {
		if (!Object.hasOwn(fields, key))
			throw new Error(`${path} has no field "${key}"`);
	}

	const unreadable = (path: string) =>
		ActionError.Refused({
			message: `${path} cannot be read: ${UNREADABLE}; fix it by hand first`,
		}).error;

	/**
	 * The file at `path` as a read gives it, with each problem and its kind.
	 * Each field is its value if it fits, else its default, else absent;
	 * `problems` names each that did not fit or is missing, and a file whose
	 * name is not the one its key makes. `path`, the keys, and `body` come
	 * from the file, and no field can be named as one of them.
	 */
	function project(path: string, found: Found) {
		const values: FieldValues = {};
		const problems: Problem[] = [];
		const problem = (line: string, kind = line) =>
			problems.push({ line, kind });
		if (!found.readable) problem(UNREADABLE);
		const keys = layout.match(path) ?? {};
		let named: string | undefined;
		try {
			named = layout.fill(keys);
		} catch {}
		if (named !== path) {
			const kind = 'its name is not the one its key makes';
			problem(named ? `${kind}, ${named}` : kind, kind);
		}
		for (const [key, schema] of Object.entries(fields)) {
			const present = Object.hasOwn(found.fields, key);
			const value = found.fields[key];
			if (present && Value.Check(schema, value)) {
				values[key] = value as JsonValue;
				continue;
			}
			if (present)
				problem(
					misfit(key, schema, value, local),
					misfit(key, schema, value, true),
				);
			else if (found.readable && !isOptional(schema) && !hasDefault(schema))
				problem(`${key} is missing`);
			if (hasDefault(schema))
				values[key] = structuredClone(
					(schema as { default: JsonValue }).default,
				);
		}
		return { row: { path, ...keys, ...values }, problems };
	}

	/** A read's `problems`: each problem's line, when there is any. */
	const lines = (problems: Problem[]) =>
		problems.length ? { problems: problems.map(({ line }) => line) } : {};

	/** `path` as `get` gives it: a row of `list` and its body. */
	function record(path: string, found: Found): AnyRecord {
		const { row, problems } = project(path, found);
		return { ...row, body: found.body, ...lines(problems) };
	}

	async function read(path: string) {
		const text = await folder.read(path);
		return text === undefined ? undefined : readMarkdown(text);
	}

	/** Throw naming each of `values` that does not fit, one a line. */
	function refuse(path: string, values: FieldValues, whole: boolean) {
		const problems: string[] = [];
		for (const [key, schema] of Object.entries(fields)) {
			if (!Object.hasOwn(values, key)) {
				if (whole && !isOptional(schema)) problems.push(`${key} is missing`);
			} else if (!Value.Check(schema, values[key]))
				problems.push(misfit(key, schema, values[key], local));
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

	/** Each field that holds a `field.ref` or a list of them, with its target's template. */
	const references = Object.entries(fields).flatMap(([key, schema]) => {
		const one = refPathOf(schema);
		const path = one ?? refPathOf((schema as { items?: unknown }).items);
		return path === undefined
			? []
			: [{ key, many: one === undefined, target: template(path) }];
	});

	/**
	 * Refuse, with `ActionError.Refused`, each key `given` would store in a
	 * reference that is not exactly the key of a record in its target: one the
	 * target's path would change, or with no file. It reads those files and
	 * writes nothing; `add` and a `set` given fields call it before they write.
	 * A change a function computes does not: what it returns is the app's own,
	 * as a `readOnly` field is.
	 */
	async function checkReferences(path: string, given: Record<string, unknown>) {
		const problems: string[] = [];
		for (const { key, many, target } of references) {
			const value = given[key];
			const [placeholder = ''] = target.placeholders;
			for (const each of many ? (Array.isArray(value) ? value : []) : [value]) {
				if (typeof each !== 'string') continue;
				const quoted = `${path}: ${quote(key, each, local)}`;
				let file: string | undefined;
				try {
					file = target.fill({ [placeholder]: each });
				} catch {
					file = undefined;
				}
				if (file === undefined || target.match(file)?.[placeholder] !== each)
					problems.push(
						`${quoted} is not a key ${target.text} can name a file by`,
					);
				else if ((await folder.read(file)) === undefined)
					problems.push(`${quoted} names no record in ${target.text}`);
			}
		}
		if (problems.length)
			throw ActionError.Refused({ message: problems.join('\n') }).error;
	}

	/** The text of a new file at `path` from the defaults, `given`, and `body`; throws when the fields do not fit. */
	function made(path: string, given: Record<string, unknown>, body: string) {
		const values: FieldValues = {};
		for (const [key, schema] of Object.entries(fields))
			if (hasDefault(schema))
				values[key] = structuredClone(
					(schema as { default: JsonValue }).default,
				);
		for (const [key, value] of Object.entries(given)) {
			known(path, key);
			if (value !== undefined) values[key] = value as JsonValue;
		}
		refuse(path, values, true);
		return markdownOf(inDeclaredOrder(values, fields), body);
	}

	/** `body` with the passage `change.old` replaced by `change.new`; throws "Changed" when the body no longer has it. */
	function edited(path: string, body: string, change: Change) {
		const { old } = change;
		const at = body.indexOf(old);
		if (old === '' ? body !== '' : at < 0)
			throw ActionError.Changed({ path, why: old === '' ? 'empty' : 'quote' })
				.error;
		if (old !== '' && body.indexOf(old, at + 1) >= 0)
			throw new Error(
				`${path}'s body has that text more than once; quote more around it`,
			);
		return old === ''
			? change.new
			: body.slice(0, at) + change.new + body.slice(at + old.length);
	}

	/**
	 * The one writer: change the file at `path` to what `change` makes of the
	 * record there, through `folder.update`, so it is written only over the
	 * record `change` was given. `need` says what the file must be first:
	 * `absent` for `add`, `present` for `set` and `edit`, `either` for
	 * `update`. When there is no file, `change` gets `undefined` and what it
	 * returns makes the file; front matter that cannot be read is refused
	 * before `change` runs.
	 */
	async function write(
		path: string,
		need: Need,
		change: (record: AnyRecord | undefined) => Write,
	) {
		const text = await folder.update(path, (before) => {
			if (before === undefined && need === 'present')
				throw ActionError.Missing({ path }).error;
			if (before !== undefined && need === 'absent')
				throw new Error(`${path} is already there`);
			const found = before === undefined ? undefined : readMarkdown(before);
			if (found && !found.readable) throw unreadable(path);
			const { fields: given, body } = change(found && record(path, found));
			if (body !== undefined && typeof body !== 'string')
				throw new Error(`${path}: body must be text`);
			if (before === undefined || !found) return made(path, given, body ?? '');
			const patch = patchOf(path, given);
			const changesFields =
				patch.removed.length > 0 || Object.keys(patch.set).length > 0;
			if (!changesFields && body === undefined) return before;
			const fielded = changesFields
				? withFields(before, found, patch.set, patch.removed)
				: before;
			// Every write keeps the body as the end of the text, so the front matter is what comes before it.
			return body === undefined
				? fielded
				: fielded.slice(0, fielded.length - found.body.length) + body;
		});
		return record(path, readMarkdown(text));
	}

	/** The paths that may be records, each read after: a template with no placeholder is its one path, so its folder is never walked. */
	async function paths() {
		if (!layout.placeholders.length) return [layout.text];
		return (await folder.list(layout.dir || undefined)).filter(
			(path) => layout.match(path) !== undefined,
		);
	}

	return {
		pathOf,
		async list() {
			const rows = [];
			for (const path of await paths()) {
				const found = await read(path);
				if (!found) continue;
				const { row, problems } = project(path, found);
				rows.push({ ...row, ...lines(problems) });
			}
			return rows;
		},
		async check() {
			const records: { path: string; problems: Problem[] }[] = [];
			let count = 0;
			for (const path of await paths()) {
				const found = await read(path);
				if (!found) continue;
				count += 1;
				const { problems } = project(path, found);
				if (problems.length) records.push({ path, problems });
			}
			return { files: count, records };
		},
		async get(keys: object) {
			const path = pathOf(keys);
			const found = await read(path);
			if (!found) return undefined;
			if (!found.readable) throw unreadable(path);
			return record(path, found);
		},
		async add(input: Record<string, unknown>) {
			const { body, ...given } = input;
			const values: Record<string, string> = {};
			for (const key of layout.placeholders) {
				const value = given[key];
				delete given[key];
				if (key === TIME) continue;
				if (typeof value !== 'string')
					throw new Error(
						`A ${layout.text} record is named by its ${key}; give it`,
					);
				values[key] = value;
			}
			const path = layout.fill(values);
			await checkReferences(path, given);
			return write(path, 'absent', () => ({ fields: given, body }));
		},
		async set(keys: object, change: unknown) {
			const path = pathOf(keys);
			if (typeof change === 'function')
				return write(path, 'present', (now) => ({
					fields: (change as (record: unknown) => Record<string, unknown>)(now),
				}));
			const given = (change ?? {}) as Record<string, unknown>;
			if (Object.values(given).every((value) => value === undefined))
				throw new Error(`Nothing to set in ${path}: give a field`);
			await checkReferences(path, given);
			return write(path, 'present', () => ({ fields: given }));
		},
		async edit(keys: object, change: Change) {
			const path = pathOf(keys);
			if (typeof change?.old !== 'string' || typeof change?.new !== 'string')
				throw new Error(`Edit ${path} with { old, new }, each text`);
			return write(path, 'present', (now) => ({
				fields: {},
				body: edited(path, (now as AnyRecord).body, change),
			}));
		},
		async update(
			keys: object,
			change: (record: unknown) => Record<string, unknown>,
		) {
			const path = pathOf(keys);
			return write(path, 'either', (now) => {
				const { body, ...fields } = change(now);
				return { fields, body };
			});
		},
		async delete(keys: object) {
			const path = pathOf(keys);
			const existed = (await folder.read(path)) !== undefined;
			await folder.delete(path);
			return existed;
		},
	};
}

/** Each verb as an action to expose, described by the collection's path; each takes the keys flat beside its input. */
function verbActions(
	def: CollectionDef,
	layout: Template,
	records: Records,
): Record<Verb, Action> {
	const what = def.description ?? `${layout.text} file`;
	const keys = layout.placeholders;
	const writable = Object.fromEntries(
		Object.entries(def.fields).filter(([, schema]) => !isReadOnly(schema)),
	);
	const keysIn: Record<string, TSchema> = Object.fromEntries(
		keys.map((key) => [
			key,
			Type.String({ description: `Which one: its {${key}} in ${layout.text}` }),
		]),
	);
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
	const addKeys = keys.filter((key) => key !== TIME);
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
	const outside = (input: Record<string, unknown>) => {
		for (const key of Object.keys(input))
			if (def.fields[key] && isReadOnly(def.fields[key]))
				throw new Error(`${key} is written only by the app's own actions`);
		return input;
	};
	/** `input` without its keys: what a verb changes. */
	const change = (input: Record<string, unknown>) =>
		Object.fromEntries(
			Object.entries(input).filter(([key]) => !keys.includes(key)),
		);
	const action = (
		run: (input: Record<string, unknown>) => unknown,
		meta: ActionMeta,
	): Action =>
		Object.assign(
			async (input?: unknown) => run((input ?? {}) as Record<string, unknown>),
			meta,
		);
	return {
		list: action(() => records.list(), {
			description: `Every ${what}: its path and fields, and the problems of one that does not fit them`,
			input: {},
			annotations: { readOnlyHint: true, ...local },
		}),
		get: action(
			async (input) => {
				const found = await records.get(input);
				if (!found)
					throw ActionError.Missing({ path: records.pathOf(input) }).error;
				return found;
			},
			{
				description: `Read one ${what}: its fields and body`,
				input: keysIn,
				positional: keys,
				annotations: { readOnlyHint: true, ...local },
			},
		),
		add: action((input) => records.add(outside(input)), {
			description: `Make a new ${what}${keys.includes(TIME) ? ', named by the time' : ''}; refused when one is already at its path`,
			input: addIn,
			positional: addKeys,
			annotations: { destructiveHint: false, ...local },
		}),
		set: action((input) => records.set(input, change(outside(input))), {
			description: `Change the fields given in one ${what}, keeping the rest and the body; null removes a field that may be absent; refused when there is none`,
			input: { ...keysIn, ...patchIn },
			positional: keys,
			annotations: { idempotentHint: true, ...local },
		}),
		edit: action(
			(input) => records.edit(input, change(input) as unknown as Change),
			{
				description: `Replace one passage of a ${what}'s body: old must appear in it exactly once, or be empty for an empty body; refused otherwise, so a passage changed since it was read is never overwritten`,
				input: { ...keysIn, ...quote },
				positional: keys,
				annotations: local,
			},
		),
		delete: action((input) => records.delete(input), {
			description: `Delete one ${what}; true when there was one`,
			input: keysIn,
			positional: keys,
			annotations: { idempotentHint: true, ...local },
		}),
	};
}
