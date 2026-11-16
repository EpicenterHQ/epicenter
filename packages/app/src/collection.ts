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
 * - `actions()`, which gives its verbs as actions to expose (`list`, `get`,
 *   `add`, `set`, and `delete` when named), each built on those methods for
 *   a caller that can send only plain data. The `set` verb is the `set`
 *   method for a caller that cannot send a function, so it sends what it
 *   last saw instead: `was` for fields, `old` for a passage of the body.
 *
 * A method names a record by its keys, each placeholder's value
 * (`{ word }` for `data/words/{word}.md`), and reads only those names, so a
 * row or a record can be passed as the keys. A key finds its file by its
 * exact name first, then by the tidy name `add` writes. A collection with no
 * placeholder (`data/settings.md`) has the same methods without the keys.
 *
 * The writers differ by what they need of the file. `add` makes a file and
 * refuses one already there. `set` changes the fields and body of a file that
 * exists, merging as JSON Merge Patch does (a field given as `null` is
 * removed); given a function, it writes what the function makes of the
 * record. `update` changes a file by what is in it, or makes it: it gives the
 * record, or `undefined`, to a function and writes what it returns over that
 * same record, as `folder.update` does for text, so a value computed from the
 * record is never written over a change made since. `set` throws
 * `ActionError.Missing` when there is no file; a file whose front matter
 * cannot be read is refused by every writer, and by `get`.
 *
 * A read gives only what the file holds: each field is its value when it
 * fits, else absent, and a file that does not fit says why in `problems`. A
 * field whose line is not JSON is absent the same way, and its problem gives
 * the line number and what to write (ADR-0924). An absent switch reads
 * `false` and an absent list with no `min` `[]` (`absentValue`). A change a
 * function computes may not write over a value that does not fit, or that is
 * not JSON.
 * `path`, the keys, and `body` always come from the file itself. Front matter
 * no field declares is kept by every write, and nothing reports it.
 *
 * A field marked `readOnly` is left out of the exposed `add` and `set`, so only
 * the app's own actions write it, through the methods. When such a field is
 * required, the collection exposes no `add` at all.
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
import type { Action, ActionMeta } from './action.ts';
import { folder, isLocalPath } from './context.ts';
import { ActionError } from './errors.ts';
import {
	absentValue,
	defaultIn,
	type FilledKeys,
	refPathOf,
	whatFits,
} from './field.ts';
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

/** A field's value as a read gives it. */
type ValueOf<F extends Fields, K extends keyof F> = Exclude<
	Static<F[K]>,
	undefined
>;

type KeysWhere<F, Mark> = {
	[K in keyof F]: F[K] extends Mark ? K : never;
}[keyof F];

/** Fields only the app's own actions write. */
type ReadOnlyKeys<F> = KeysWhere<F, { readOnly: true }>;

/** Fields a file may go without, which `null` removes. */
type OptionalKeys<F> = KeysWhere<F, { '~optional': true }>;

/** Fields `add` could never be given: written only by the app's own actions, and required. */
type UnaddableKeys<F> = Exclude<ReadOnlyKeys<F>, OptionalKeys<F>>;

/** Fields a record that fits may lack: the optional ones, less a switch or a list, which reads `false` or `[]`. */
type MayLack<F> = Exclude<OptionalKeys<F>, FilledKeys<F>>;

/** The fields given to `set`: any of them, and `null` for one a file may go without. */
type Patch<F extends Fields, K extends keyof F = keyof F> = {
	-readonly [P in K]?:
		| Values<F>[P & keyof Values<F>]
		| (P extends OptionalKeys<F> ? null : never);
};

/**
 * The fields of a record with no `problems`: every required field, a switch,
 * and a list are there, and an optional field may be absent.
 */
type Fitting<F extends Fields> = {
	-readonly [K in Exclude<keyof F, MayLack<F>>]-?: ValueOf<F, K>;
} & { -readonly [K in MayLack<F>]?: ValueOf<F, K> };

/** The fields of a record with `problems`: any of them may be absent, since a value that does not fit reads as absent. */
type Loose<F extends Fields> = { -readonly [K in keyof F]?: ValueOf<F, K> };

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

/** What a file is besides its fields: its path, its keys, and maybe more, such as its body. */
type Named<D extends CollectionDef, More> = { path: string } & Keys<D> & More;

/**
 * `More` and the fields as a read gives them: a record with no `problems`
 * has its required fields, so `!record.problems` makes them safe to use;
 * one with `problems`, one line per problem, may lack any field.
 */
type Read<D extends CollectionDef, More> =
	| Simplify<Named<D, More> & Fitting<D['fields']> & { problems?: undefined }>
	| Simplify<Named<D, More> & Loose<D['fields']> & { problems: string[] }>;

/** A row of the `list` verb: the file's path, its keys, its fields, and its problems. */
export type Row<D extends CollectionDef> = Read<D, unknown>;

/** One record as `get` and `list` read it: a row and its body. */
export type RecordOf<D extends CollectionDef> = Read<D, { body: string }>;

/** The keys a caller gives when adding: every one but `{time}`, which `add` makes. */
type AddKeys<D extends CollectionDef> = Exclude<
	Placeholders<D['path']>,
	typeof TIME
>;

/** What `add` takes: the whole new record, its keys, its fields, and maybe a body. */
type AddInput<D extends CollectionDef, K extends keyof D['fields']> = Simplify<
	{ [P in AddKeys<D>]: string } & Pick<
		Values<D['fields']>,
		K & keyof Values<D['fields']>
	> & {
			body?: string;
		}
>;

type Writable<D extends CollectionDef> = Exclude<
	keyof D['fields'],
	ReadOnlyKeys<D['fields']>
>;

/** What `set` and `update` write: the fields to change, `null` removing one a file may go without, and a new body if it changes. */
type Change<F extends Fields> = Simplify<Patch<F> & { body?: string }>;

/** What `set` takes after the keys: the change, or a function of the record that returns it. */
type SetChange<D extends CollectionDef> =
	| Change<D['fields']>
	| ((record: RecordOf<D>) => Change<D['fields']>);

/**
 * The function `update` calls with the record as it is, or `undefined` when
 * there is no file, returning what to change in it; when there was no file,
 * what it returns is the whole new record.
 */
type Revise<D extends CollectionDef> = (
	record: RecordOf<D> | undefined,
) => Change<D['fields']>;

/** A collection's methods, as an action uses them. */
export type Handle<D extends CollectionDef> = {
	/** Every record, whole, as `get` gives it, sorted by path. */
	list(): Promise<RecordOf<D>[]>;
	/** The record the keys name, or `undefined` when there is no file. */
	get(...keys: KeysArg<D>): Promise<RecordOf<D> | undefined>;
	/** Make a file from the whole new record; throws when one is already at its path. */
	add(record: AddInput<D, keyof D['fields']>): Promise<RecordOf<D>>;
	/**
	 * Change the fields given, and the body when `body` is given; `null`
	 * removes a field a file may go without. Given a function, write what it
	 * returns for the record as it is, only over that record, as `update`
	 * does; it may not write a field whose value does not fit, which plain
	 * data repairs. Throws `ActionError.Missing` when there is no file.
	 *
	 * ```ts
	 * await words.set({ word }, { meaning });
	 * await words.set({ word }, (now) => ({ reps: (now.reps ?? 0) + 1 }));
	 * await words.set({ word }, (now) => ({ body: `${now.body}${line}\n` }));
	 * ```
	 */
	set(...args: [...KeysArg<D>, change: SetChange<D>]): Promise<RecordOf<D>>;
	/**
	 * Change the file by what is in it, or make it. `change` gets the record
	 * as `get` gives it, `undefined` when there is no file, and returns what
	 * `set` takes; that is written only over the record it was given, and
	 * makes the file, as `add` would, when there was none. When the file
	 * changed meanwhile, `change` runs again on what is there now, so keep it
	 * a pure function of the record; after 10 tries it throws
	 * `ActionError.Changed`. A `change` that throws writes nothing, and one
	 * that returns `{}` for a file leaves it as it is. Like `set` given a
	 * function, it may not write a field whose value does not fit. Returns the
	 * record written.
	 *
	 * ```ts
	 * await words.update({ word }, (now) => ({ reps: (now?.reps ?? 0) + 1 }));
	 * ```
	 */
	update(...args: [...KeysArg<D>, change: Revise<D>]): Promise<RecordOf<D>>;
	/** Delete the file; `true` when there was one. */
	delete(...keys: KeysArg<D>): Promise<boolean>;
	/** The path `add` makes for the keys, tidied: `pathOf({ word: '你好' })` is `data/words/你好.md`. */
	pathOf(...keys: KeysArg<D>): string;
};

/** The verbs a collection may expose. */
export type Verb = 'list' | 'get' | 'add' | 'set' | 'delete';

/** The verbs that fit a collection: all five, less `add` when a field `add` could never be given is required. */
type VerbOf<D extends CollectionDef> = [UnaddableKeys<D['fields']>] extends [
	never,
]
	? Verb
	: Exclude<Verb, 'add'>;

/** The verbs `actions()` gives when none is named: every one that fits but `delete`. */
type Given<D extends CollectionDef> = Exclude<VerbOf<D>, 'delete'>;

/** The input of `get` and `delete`: the keys alone, and nothing for a collection with no placeholder. */
type KeysIn<D extends CollectionDef> =
	IsSingle<D['path']> extends true ? Record<string, never> : Keys<D>;

/** The values a caller last saw, as the `set` verb's `was` names them: `null` for a field that was absent. */
type Was<D extends CollectionDef> = {
	-readonly [K in keyof D['fields']]?: ValueOf<D['fields'], K> | null;
};

/** The passage of the body the `set` verb replaces: `old` as the caller last saw it and `new` together, or neither. */
type Passage = { old?: never; new?: never } | { old: string; new: string };

/** The action verb `V` gives: its keys flat beside the rest of its input. */
type VerbAction<D extends CollectionDef, V extends Verb> = {
	list: Action<Record<string, never>, Promise<Row<D>[]>, never>;
	get: Action<KeysIn<D>, Promise<RecordOf<D>>, never>;
	add: Action<AddInput<D, Writable<D>>, Promise<RecordOf<D>>, never>;
	set: Action<
		Simplify<
			Keys<D> & Patch<D['fields'], Writable<D>> & { was?: Was<D> } & Passage
		>,
		Promise<RecordOf<D>>,
		never
	>;
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
		/** Its actions, each under its verb: every verb that fits it but `delete`. */
		actions(): CollectionActions<D, Given<D>>;
		/** The actions of the verbs named, `delete` among those it may name. */
		actions<V extends VerbOf<D>>(
			...verbs: [V, ...V[]]
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
		.filter(([, schema]) => isReadOnly(schema) && !isOptional(schema))
		.map(([key]) => key);
	const fit = unaddable.length ? VERBS.filter((verb) => verb !== 'add') : VERBS;
	return {
		...definition,
		list: records.list,
		add: records.add,
		get: named(records.get, 0),
		set: named(records.set, 1),
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
				if ((verb as string) === 'edit')
					throw new Error(
						`${layout.text} has no "edit": set takes old and new now, replacing a passage of the body in the same write as the fields`,
					);
				if (verb === 'add')
					throw new Error(
						`${layout.text} has no "add": ${unaddable.join(', ')} ${unaddable.length === 1 ? 'is' : 'are'} written only by the app's own actions and required, so an exposed add could never be given ${unaddable.length === 1 ? 'it' : 'them'}; write the app's own add with defineAction`,
					);
				throw new Error(
					`${layout.text} has no "${verb}"; it has ${fit.join(', ')}`,
				);
			}
			const all = verbActions(definition, layout, records);
			return Object.fromEntries(
				(verbs.length ? verbs : fit.filter((verb) => verb !== 'delete')).map(
					(verb) => [verb, all[verb]],
				),
			);
		},
	} as unknown as Collection<D>;
}

const VERBS: readonly Verb[] = ['list', 'get', 'add', 'set', 'delete'];

/**
 * Names neither a field nor a placeholder may have, and why: a read gives
 * `path`, `body`, and `problems` itself, and the `set` verb takes `was`,
 * `old`, and `new` beside the fields.
 */
const RESERVED: ReadonlyMap<string, string> = new Map([
	['path', "which is the file's address"],
	['body', "which is the file's text after its front matter"],
	['problems', 'which a read uses to say what does not fit'],
	['was', 'which the set verb takes beside the fields'],
	['old', 'which the set verb takes beside the fields'],
	['new', 'which the set verb takes beside the fields'],
]);

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
	// Collection fields must be publishable as JSON, independently of action policy.
	JSON.stringify(def.fields);
	const keys = new Set(template(path).placeholders);
	const at = `The collection at ${path}`;
	const problems: string[] = [];
	for (const key of keys) {
		const reserved = RESERVED.get(key);
		if (reserved)
			problems.push(`${at} has the placeholder {${key}}, ${reserved}`);
	}
	for (const [key, schema] of Object.entries(def.fields ?? {})) {
		if (containsFileMarker(schema))
			problems.push(
				`${at} has the file field "${key}", which a collection of one file per record cannot keep; it would store the host's temporary upload reference`,
			);
		if (defaultIn(schema))
			problems.push(
				`${at} has a default in the field "${key}"; a read gives only what the file holds, so write the default in code where the value is read, such as \`limit ?? 50\``,
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

/**
 * What a read says of a field whose line is not JSON, and what to write: the
 * text in double quotes when that fits the field, else what the field takes.
 * Without `line` and with `local`, it quotes nothing: the problem's kind.
 */
function notJsonProblem(
	key: string,
	schema: TSchema,
	{ line, text }: { line?: number; text: string },
	local: boolean,
): string {
	const which = `${key}${line === undefined ? '' : ` on line ${line}`} is not JSON`;
	if (text.trim() === '')
		return `${which}: it has no value; give it one as JSON, or remove the line`;
	if (Value.Check(schema, text))
		return `${which}; write ${local ? 'its text in double quotes' : `${key}: ${JSON.stringify(text)}`}`;
	const words = whatFits(schema, text);
	return words
		? `${which}; ${key} takes ${words}, written as JSON`
		: `${which}; write its value as JSON`;
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
	'its front matter is not key: value lines between two --- lines, each key once';

/** A read's front matter: its fields, its body, and whether the front matter could be read. */
type Found = ReturnType<typeof readMarkdown>;

/** A record as a read gives it, before its types are laid over. */
type AnyRecord = Record<string, unknown> & { path: string; body: string };

/** What a write changes: the fields to set or remove, as `set` takes them, and a new body if it changes. */
type Write = { fields: Record<string, unknown>; body?: unknown };

/** What a writer needs of the file before it writes: that it is not there, that it is, or either. */
type Need = 'absent' | 'present' | 'either';

/**
 * Where a write's change comes from. `data` is plain data a caller gave,
 * which may repair a value that does not fit. `computed` is what a function
 * returned from the record, which may not replace such a value, since the
 * function saw it as absent.
 */
type Source = 'data' | 'computed';

/** A collection's records, each named by its keys, read and written through the folder of the run they are called in. */
type Records = ReturnType<typeof createRecords>;

function createRecords(layout: Template, fields: Fields) {
	const local = isLocalPath(layout.text);

	/** Each placeholder's value from `keys`, and nothing else from it; throws for one that is not text. */
	function valuesOf(keys: object): Record<string, string> {
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
		return values;
	}

	/** The path `add` makes for `keys`: each value as NFC, trimmed, and with single spaces. */
	function pathOf(keys: object): string {
		return layout.fill(valuesOf(keys));
	}

	/**
	 * The file `keys` name and its text: the file named by the keys exactly as
	 * given when it is there, else the one named by the tidy form `add` makes,
	 * which may be absent.
	 */
	async function find(
		keys: object,
	): Promise<{ path: string; text: string | undefined }> {
		const exact = layout.fillExact(valuesOf(keys));
		if (exact !== undefined) {
			const text = await folder.read(exact);
			if (text !== undefined) return { path: exact, text };
		}
		const path = pathOf(keys);
		return { path, text: path === exact ? undefined : await folder.read(path) };
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
	 * The file at `path` as a read gives it, with each problem and its kind,
	 * and the fields whose values did not fit. Each field is its value if it
	 * fits, else absent; an absent switch or list is `false` or `[]`.
	 * `problems` names each value that did not fit, each line whose text is
	 * not JSON with what to write, and each required field that is missing.
	 * `path`, the keys, and `body` come from the file, and no field can be
	 * named as one of them. A field whose line is not JSON counts among the
	 * values that did not fit.
	 */
	function project(path: string, found: Found) {
		const values: Record<string, unknown> = {};
		const problems: Problem[] = [];
		const misfits = new Set<string>();
		const problem = (line: string, kind = line) =>
			problems.push({ line, kind });
		if (!found.readable) problem(UNREADABLE);
		const notJson = new Map(found.notJson.map((each) => [each.key, each]));
		for (const [key, schema] of Object.entries(fields)) {
			const value = found.fields[key];
			const bare = notJson.get(key);
			if (bare) {
				misfits.add(key);
				problem(
					notJsonProblem(key, schema, bare, local),
					notJsonProblem(key, schema, { text: bare.text }, true),
				);
			} else if (!Object.hasOwn(found.fields, key)) {
				const absent = absentValue(schema);
				if (absent !== undefined) values[key] = structuredClone(absent);
				else if (found.readable && !isOptional(schema))
					problem(`${key} is missing`);
			} else if (Value.Check(schema, value)) values[key] = value;
			else {
				misfits.add(key);
				problem(
					misfit(key, schema, value, local),
					misfit(key, schema, value, true),
				);
			}
		}
		const record: AnyRecord = {
			path,
			...layout.match(path),
			...values,
			body: found.body,
			...(problems.length
				? { problems: problems.map(({ line }) => line) }
				: {}),
		};
		return { record, problems, misfits };
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
	 * reference that is not the key of a record in its target. A key is good
	 * when `get` on the target would find a record by it, by its exact name
	 * first and then its tidy name, and that record's key is the key given, so
	 * `" essays "` is refused where `essays.md` is the record it finds. It
	 * reads those files and writes nothing; `add` and a `set` given plain data
	 * call it before they write. A change a function computes does not: what
	 * it returns is the app's own, as a `readOnly` field is.
	 */
	async function checkReferences(path: string, given: Record<string, unknown>) {
		const problems: string[] = [];
		for (const { key, many, target } of references) {
			const value = given[key];
			const [placeholder = ''] = target.placeholders;
			for (const each of many ? (Array.isArray(value) ? value : []) : [value]) {
				if (typeof each !== 'string') continue;
				const quoted = `${path}: ${quote(key, each, local)}`;
				const exact = target.fillExact({ [placeholder]: each });
				let tidy: string | undefined;
				try {
					tidy = target.fill({ [placeholder]: each });
				} catch {
					tidy = undefined;
				}
				if (exact === undefined && tidy === undefined) {
					problems.push(
						`${quoted} is not a key ${target.text} can name a file by`,
					);
					continue;
				}
				if (exact !== undefined && (await folder.read(exact)) !== undefined)
					continue;
				if (
					tidy === undefined ||
					tidy === exact ||
					(await folder.read(tidy)) === undefined
				) {
					problems.push(`${quoted} names no record in ${target.text}`);
					continue;
				}
				const found = target.match(tidy)?.[placeholder] ?? '';
				problems.push(
					`${quoted} is not exactly the key of its record in ${target.text}; write ${local ? 'its key as the file names it' : JSON.stringify(found)}`,
				);
			}
		}
		if (problems.length)
			throw ActionError.Refused({ message: problems.join('\n') }).error;
	}

	/**
	 * The text of a new file at `path` from `given` and `body`, and nothing
	 * else; throws when the fields do not fit. `null` for a field a file may go
	 * without leaves it out, as it removes one from a file that is there, so one
	 * change can make a record or change it.
	 */
	function made(path: string, given: Record<string, unknown>, body: string) {
		const values: FieldValues = {};
		for (const [key, value] of Object.entries(given)) {
			known(path, key);
			if (value === undefined) continue;
			if (value === null && isOptional(fields[key] as TSchema)) continue;
			values[key] = value as JsonValue;
		}
		refuse(path, values, true);
		return markdownOf(inDeclaredOrder(values, fields), body);
	}

	/**
	 * The one writer: change the file at `path` to what `change` makes of the
	 * record there, through `folder.update`, so it is written only over the
	 * record `change` was given. `need` says what the file must be first:
	 * `absent` for `add`, `present` for `set`, `either` for `update`. When
	 * there is no file, `change` gets `undefined` and what it returns makes
	 * the file; front matter that cannot be read is refused before `change`
	 * runs. A `computed` change that writes a field whose value does not fit
	 * is refused, and writes nothing.
	 */
	async function write(
		path: string,
		need: Need,
		source: Source,
		change: (record: AnyRecord | undefined) => Write,
	) {
		const text = await folder.update(path, (before) => {
			if (before === undefined && need === 'present')
				throw ActionError.Missing({ path }).error;
			if (before !== undefined && need === 'absent')
				throw new Error(`${path} is already there`);
			const found = before === undefined ? undefined : readMarkdown(before);
			if (found && !found.readable) throw unreadable(path);
			const now = found && project(path, found);
			const { fields: given, body } = change(now?.record);
			if (body !== undefined && typeof body !== 'string')
				throw new Error(`${path}: body must be text`);
			if (before === undefined || !found) return made(path, given, body ?? '');
			const replaced = Object.keys(given).filter(
				(key) => given[key] !== undefined && now?.misfits.has(key),
			);
			if (source === 'computed' && replaced.length)
				throw ActionError.Refused({
					message: replaced
						.map(
							(key) =>
								`${path}: ${key} holds a value that does not fit, which the change was given as absent, so it may not replace it; repair ${key} with plain data first`,
						)
						.join('\n'),
				}).error;
			const patch = patchOf(path, given);
			const changesFields =
				patch.removed.length > 0 || Object.keys(patch.set).length > 0;
			if (!changesFields && body === undefined) return before;
			const fielded = changesFields
				? withFields(before, patch.set, patch.removed)
				: before;
			// Every write keeps the body as the end of the text, so the front matter is what comes before it.
			return body === undefined
				? fielded
				: fielded.slice(0, fielded.length - found.body.length) + body;
		});
		return project(path, readMarkdown(text)).record;
	}

	/** A change a function returned, split as `write` takes it. */
	const computed =
		(change: (record: unknown) => Record<string, unknown>) =>
		(now: AnyRecord | undefined): Write => {
			const { body, ...given } = change(now);
			return { fields: given, body };
		};

	/** The paths that may be records, each read after: a template with no placeholder is its one path, so its folder is never walked. */
	async function paths() {
		if (!layout.placeholders.length) return [layout.text];
		return (await folder.list(layout.dir || undefined)).filter(
			(path) => layout.match(path) !== undefined,
		);
	}

	/** Each file that is there, read, with its path. */
	async function readAll() {
		const read: { path: string; found: Found }[] = [];
		for (const path of await paths()) {
			const text = await folder.read(path);
			if (text !== undefined) read.push({ path, found: readMarkdown(text) });
		}
		return read;
	}

	/**
	 * Write plain data a caller gave over the file `keys` name: `given`'s
	 * fields, and `body` when it is given. A caller that cannot send a
	 * function sends what it last saw instead, each checked inside the same
	 * write before anything is written: `was` names fields and their values,
	 * `null` for absent, refused as `Changed` with `why: 'was'` when one
	 * differs; `passage` replaces `old` in the body with `new`, refused as
	 * `edited` refuses it. `create` makes the file, as `add` would, when it is
	 * absent; a passage needs a file to be in, so with none it is `Missing`.
	 */
	async function put(
		keys: object,
		given: Record<string, unknown>,
		{
			body,
			was,
			passage,
			create = false,
		}: {
			body?: unknown;
			was?: Record<string, unknown>;
			passage?: { old: string; new: string };
			create?: boolean;
		},
	) {
		const { path } = await find(keys);
		if (
			body === undefined &&
			passage === undefined &&
			Object.values(given).every((value) => value === undefined)
		)
			throw new Error(`Nothing to set in ${path}: give a field`);
		for (const key of Object.keys(was ?? {})) known(path, key);
		await checkReferences(path, given);
		return write(path, create ? 'either' : 'present', 'data', (now) => {
			for (const [key, seen] of Object.entries(was ?? {}))
				if (!Value.Equal(now?.[key] ?? null, seen ?? null))
					throw ActionError.Changed({ path, why: 'was' }).error;
			if (!passage) return { fields: given, body };
			if (!now) throw ActionError.Missing({ path }).error;
			return {
				fields: given,
				body: edited(path, now.body, passage.old, passage.new),
			};
		});
	}

	return {
		pathOf,
		put,
		async list() {
			return (await readAll()).map(
				({ path, found }) => project(path, found).record,
			);
		},
		async check() {
			const read = await readAll();
			const records: { path: string; problems: Problem[] }[] = [];
			for (const { path, found } of read) {
				const { problems } = project(path, found);
				if (problems.length) records.push({ path, problems });
			}
			return { files: read.length, records };
		},
		async get(keys: object) {
			const { path, text } = await find(keys);
			if (text === undefined) return undefined;
			const found = readMarkdown(text);
			if (!found.readable) throw unreadable(path);
			return project(path, found).record;
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
			return write(path, 'absent', 'data', () => ({ fields: given, body }));
		},
		async set(keys: object, change: unknown) {
			if (typeof change === 'function') {
				const { path } = await find(keys);
				return write(
					path,
					'present',
					'computed',
					computed(change as (record: unknown) => Record<string, unknown>),
				);
			}
			const { body, ...given } = (change ?? {}) as Record<string, unknown>;
			return put(keys, given, { body });
		},
		async update(
			keys: object,
			change: (record: unknown) => Record<string, unknown>,
		) {
			const { path } = await find(keys);
			return write(path, 'either', 'computed', computed(change));
		},
		async delete(keys: object) {
			const { path, text } = await find(keys);
			await folder.delete(path);
			return text !== undefined;
		},
	};
}

/** `body` with the passage `old` replaced by `replacement`; throws `Changed` unless `old` is there exactly once, or empty for an empty body. */
function edited(path: string, body: string, old: string, replacement: string) {
	if (old === '') {
		if (body !== '') throw ActionError.Changed({ path, why: 'empty' }).error;
		return replacement;
	}
	const at = body.indexOf(old);
	if (at < 0) throw ActionError.Changed({ path, why: 'quote' }).error;
	if (body.indexOf(old, at + 1) >= 0)
		throw ActionError.Changed({ path, why: 'twice' }).error;
	return body.slice(0, at) + replacement + body.slice(at + old.length);
}

/** Each verb as an action to expose, described by the collection's path; each takes the keys flat beside its input. */
function verbActions(
	def: CollectionDef,
	layout: Template,
	records: Records,
): Record<Verb, Action> {
	const what = def.description ?? `${layout.text} file`;
	const keys = layout.placeholders;
	const keyed = keys.length > 0;
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
		const described = (schema as { description?: string }).description;
		patchIn[key] = Type.Optional(
			isOptional(schema)
				? Type.Union([schema, Type.Null()], {
						description: described
							? `${described}; null removes it`
							: 'null removes it',
					})
				: schema,
		);
	}
	const was = Type.Optional(
		Type.Object(
			Object.fromEntries(
				Object.keys(def.fields).map((key) => [
					key,
					Type.Optional(Type.Unknown()),
				]),
			),
			{
				additionalProperties: false,
				description:
					'The values you last saw, by field, null for one that was absent; refused when one has changed since',
			},
		),
	);
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
	const passageIn = {
		old: Type.Optional(
			Type.String({
				description:
					'The passage of the body to replace, exactly as get returned it: once in the body, or the whole body, or empty for an empty body; refused when it is not there now. Give it with new',
			}),
		),
		new: Type.Optional(
			Type.String({
				description: 'The text to put in place of old. Give it with old',
			}),
		),
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
	const rest = (input: Record<string, unknown>) =>
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
		list: action(
			async () => (await records.list()).map(({ body: _, ...row }) => row),
			{
				description: `Every ${what}: its path and fields, and the problems of one that does not fit them`,
				input: {},
				annotations: { readOnlyHint: true, ...local },
			},
		),
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
				annotations: { readOnlyHint: true, ...local },
			},
		),
		add: action((input) => records.add(outside(input)), {
			description: `Make a new ${what}${keys.includes(TIME) ? ', named by the time' : ''}; refused when one is already at its path`,
			input: addIn,
			annotations: { destructiveHint: false, ...local },
		}),
		set: action(
			(input) => {
				const { was, old, new: replacement, ...given } = rest(outside(input));
				const passage = old !== undefined || replacement !== undefined;
				if (
					passage &&
					(typeof old !== 'string' || typeof replacement !== 'string')
				)
					throw new Error(
						`Set a passage of the body of ${layout.text} with old and new together, each text: old as you last saw it, and new to put in its place`,
					);
				return records.put(input, given, {
					was: was as Record<string, unknown> | undefined,
					passage: passage
						? { old: old as string, new: replacement as string }
						: undefined,
					create: !keyed,
				});
			},
			{
				description: `Change one ${what} in one write: the fields given, keeping the rest (null removes one that may be absent), and with old and new, the passage old of the body replaced by new. Refused, writing nothing, when ${keyed ? `there is no such ${what}, or ` : 'old is given and there is no file yet (with fields alone it makes the file), or '}when a value in was or the passage old is not what is there now`,
				input: { ...keysIn, ...patchIn, was, ...passageIn },
				annotations: local,
			},
		),
		delete: action((input) => records.delete(input), {
			description: `Delete one ${what}; true when there was one`,
			input: keysIn,
			annotations: { idempotentHint: true, ...local },
		}),
	};
}
