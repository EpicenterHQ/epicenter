/**
 * Collections read Markdown files as Results: Ok(record), Ok(undefined) for an
 * absent keyed file, or Err(Misfit). A record's path, keys and body come from
 * the file. Absent switches read false and absent lists without min read [].
 * Misfit carries the fields that fit for a repair form.
 *
 * Methods name a record by its keys and read only those names, so a row or a
 * record can be passed as keys. Lookup tries the exact filename first, then
 * the tidy name add writes. A keyless collection reads as an empty record
 * before its file exists; set creates it and there is no add.
 *
 * Writes merge as JSON Merge Patch: null removes an optional field. Every
 * write keeps front matter no field declares. Plain set patches can repair
 * readable files, but must make the whole record fit before writing.
 * Computed set and update receive only fitting records and return Ok(change)
 * or Err(error). Update retries its pure callback when the file changes
 * meanwhile; after 10 tries it answers Err(Changed). Refusals are Results;
 * callback faults and I/O failures throw.
 *
 * Generated verbs expose plain-data operations. The set verb guards fields
 * with was, the values last read (null for absent), and replaces a passage
 * with edit: { old, new }. Both guards run in the same write. readOnly fields
 * are left out of the exposed add and set; a required readOnly field removes
 * the add verb. Methods can still write those fields.
 *
 * A .local collection's methods work, but actions() throws. Its Misfits omit
 * record, and no diagnostic or write refusal quotes a file or supplied value.
 */
import { type Static, type TObject, type TSchema, Type } from 'typebox';
import { Value } from 'typebox/value';
import { Err, Ok, type Result } from 'wellcrafted/result';
import type { Action, ActionMeta } from './action.ts';
import { isActionResult } from './action-result.ts';
import { folder, isLocalPath } from './context.ts';
import { ActionError, type Problem } from './errors.ts';

export type { Problem } from './errors.ts';

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
 * The fields of a fitting record: every required field, a switch,
 * and a list are there, and an optional field may be absent.
 */
type Fitting<F extends Fields> = {
	-readonly [K in Exclude<keyof F, MayLack<F>>]-?: ValueOf<F, K>;
} & { -readonly [K in MayLack<F>]?: ValueOf<F, K> };

/** The partial fields carried by a Misfit: any of them may be absent, since a value that does not fit reads as absent. */
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

/** A fitting record, with required fields, filled switches and lists, and body. */
export type RecordOf<D extends CollectionDef> = Simplify<
	Named<D, { body: string }> & Fitting<D['fields']>
>;
/** A fitting record without its body. */
export type Row<D extends CollectionDef> = Simplify<
	Named<D, unknown> & Fitting<D['fields']>
>;
/** A malformed file, optionally carrying the fields that fit for repair. */
export type MisfitOf<
	D extends CollectionDef,
	More = { body: string },
> = Simplify<
	Pick<Misfit, 'name' | 'message' | 'namespace' | 'path' | 'problems'> & {
		record?: Simplify<Named<D, More> & Loose<D['fields']>>;
	}
>;
type Misfit = Extract<ActionError, { name: 'Misfit' }>;
type Missing = Extract<ActionError, { name: 'Missing' }>;
type Refused = Extract<ActionError, { name: 'Refused' }>;
type Changed = Extract<ActionError, { name: 'Changed' }>;
type Single<D extends CollectionDef> = IsSingle<D['path']>;
type SetError<D extends CollectionDef> =
	| (Single<D> extends true ? never : Missing)
	| MisfitOf<D>
	| Refused
	| Changed;
type CallbackError = { name: string; message: string };

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

/** Methods return expected failures as Results. Callback faults and I/O failures throw. */
export type Handle<D extends CollectionDef> = {
	/** One Result per existing file, sorted by path. */
	list(): Promise<Result<RecordOf<D>, MisfitOf<D>>[]>;
	/** Delete the file; true when it existed. Invalid keys throw. */
	delete(...keys: KeysArg<D>): Promise<boolean>;
	/** The tidied path for these keys. Invalid keys throw. */
	pathOf(...keys: KeysArg<D>): string;
} & (Single<D> extends true
	? {
			/** Read the fitting record, including the empty record before creation. */
			get(): Promise<Result<RecordOf<D>, MisfitOf<D>>>;
			/** Patch fields and body, validating the whole record before writing. */
			set(
				change: Change<D['fields']>,
			): Promise<Result<RecordOf<D>, SetError<D>>>;
			/** Compute a patch from the fitting record. Err leaves the file unchanged. */
			set<
				R extends Result<Change<D['fields']>, CallbackError> = Result<
					Change<D['fields']>,
					never
				>,
			>(
				change: (record: RecordOf<D>) => R,
			): Promise<Result<RecordOf<D>, SetError<D> | Exclude<R['error'], null>>>;
			/** Update or create, retrying the callback when the file changes meanwhile. */
			update<
				R extends Result<Change<D['fields']>, CallbackError> = Result<
					Change<D['fields']>,
					never
				>,
			>(
				change: (record: RecordOf<D>) => R,
			): Promise<
				Result<
					RecordOf<D>,
					MisfitOf<D> | Refused | Changed | Exclude<R['error'], null>
				>
			>;
		}
	: {
			/** Read a fitting record, permitted absence, or Misfit. */
			get(
				keys: Keys<D>,
			): Promise<Result<RecordOf<D> | undefined, MisfitOf<D> | Refused>>;
			/** Make a file from a complete record. */
			add(
				record: AddInput<D, keyof D['fields']>,
			): Promise<Result<RecordOf<D>, Refused | Changed>>;
			/** Patch fields and body, validating the whole record before writing. */
			set(
				keys: Keys<D>,
				change: Change<D['fields']>,
			): Promise<Result<RecordOf<D>, SetError<D>>>;
			/** Compute a patch from a fitting record. Err leaves the file unchanged. */
			set<
				R extends Result<Change<D['fields']>, CallbackError> = Result<
					Change<D['fields']>,
					never
				>,
			>(
				keys: Keys<D>,
				change: (record: RecordOf<D>) => R,
			): Promise<Result<RecordOf<D>, SetError<D> | Exclude<R['error'], null>>>;
			/** Update or create, retrying the callback when the file changes meanwhile. */
			update<
				R extends Result<Change<D['fields']>, CallbackError> = Result<
					Change<D['fields']>,
					never
				>,
			>(
				keys: Keys<D>,
				change: (record: RecordOf<D> | undefined) => R,
			): Promise<
				Result<
					RecordOf<D>,
					MisfitOf<D> | Refused | Changed | Exclude<R['error'], null>
				>
			>;
		});

/** The verbs a collection may expose. */
export type Verb = 'list' | 'get' | 'add' | 'set' | 'delete';

/** The verbs that fit a collection: all five, less `add` when a field `add` could never be given is required. */
type VerbOf<D extends CollectionDef> =
	Single<D> extends true
		? Exclude<Verb, 'add'>
		: [UnaddableKeys<D['fields']>] extends [never]
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

/** The passage of the body the `set` verb replaces: `old` as the caller last saw it, and `new` to put in its place. */
type Edit = { old: string; new: string };

/** The action verb `V` gives: its keys flat beside the rest of its input. */
type VerbAction<D extends CollectionDef, V extends Verb> = {
	list: Action<
		Record<string, never>,
		Promise<Result<Result<Row<D>, MisfitOf<D, unknown>>[], never>>,
		never
	>;
	get: Action<
		KeysIn<D>,
		Promise<
			Result<
				RecordOf<D>,
				MisfitOf<D> | (Single<D> extends true ? never : Missing | Refused)
			>
		>,
		never
	>;
	add: Action<
		AddInput<D, Writable<D>>,
		Promise<Result<RecordOf<D>, Refused | Changed>>,
		never
	>;
	set: Action<
		Simplify<
			Keys<D> & Patch<D['fields'], Writable<D>> & { was?: Was<D>; edit?: Edit }
		>,
		Promise<Result<RecordOf<D>, SetError<D>>>,
		never
	>;
	delete: Action<
		KeysIn<D>,
		Promise<Result<boolean, Single<D> extends true ? never : Refused>>,
		never
	>;
}[V];

/** What `.actions(...)` returns: each verb's action under the verb. */
export type CollectionActions<D extends CollectionDef, V extends Verb> = {
	[P in V]: VerbAction<D, P>;
};

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
	const fit =
		!keyed || unaddable.length ? VERBS.filter((verb) => verb !== 'add') : VERBS;
	return {
		...definition,
		list: records.list,
		...(keyed ? { add: records.add } : {}),
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
						`${layout.text} has no "edit": set takes edit: { old, new } now, replacing a passage of the body in the same write as the fields`,
					);
				if (verb === 'add' && !keyed)
					throw new Error(
						`${layout.text} has no "add": it is one file, which set makes`,
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
 * `path` and `body` itself, and the `set` verb takes `was` and
 * `edit` beside the fields.
 */
const RESERVED: ReadonlyMap<string, string> = new Map([
	['path', "which is the file's address"],
	['body', "which is the file's text after its front matter"],
	['was', 'which the set verb takes beside the fields'],
	['edit', 'which the set verb takes beside the fields'],
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
		if (!keys.size && !isOptional(schema) && absentValue(schema) === undefined)
			problems.push(
				`The collection at ${path} is one file, read as empty before it exists, so the field "${key}" must be optional, a switch, or a list without min`,
			);
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
	): Promise<Result<{ path: string; text: string | undefined }, Refused>> {
		const values = valuesOf(keys);
		const exact = layout.fillExact(values);
		if (exact !== undefined) {
			const text = await folder.read(exact);
			if (text !== undefined) return Ok({ path: exact, text });
		}
		let path: string;
		try {
			path = layout.fill(values);
		} catch (error) {
			return ActionError.Refused({ message: (error as Error).message });
		}
		return Ok({
			path,
			text: path === exact ? undefined : await folder.read(path),
		});
	}

	function unknownField(path: string, key: string) {
		if (!Object.hasOwn(fields, key))
			return ActionError.Refused({ message: `${path} has no field "${key}"` });
	}

	/**
	 * The file at `path` as a read gives it, with each problem and its kind,
	 * and the partial record for repair. Each field is its value if it
	 * fits, else absent; an absent switch or list is `false` or `[]`.
	 * Its diagnostics name each value that did not fit, each line whose text is
	 * not JSON with what to write, and each required field that is missing.
	 * `path`, the keys, and `body` come from the file, and no field can be
	 * named as one of them. A field whose line is not JSON counts among the
	 * values that did not fit.
	 */
	function project(path: string, found: Found) {
		const values: Record<string, unknown> = {};
		const problems: Problem[] = [];
		const problem = (line: string, kind = line) =>
			problems.push({ line, kind });
		if (!found.readable) problem(UNREADABLE);
		const notJson = new Map(found.notJson.map((each) => [each.key, each]));
		for (const [key, schema] of Object.entries(fields)) {
			const value = found.fields[key];
			const bare = notJson.get(key);
			if (bare) {
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
		};
		const result: Result<AnyRecord, Misfit> = problems.length
			? ActionError.Misfit({
					path,
					problems,
					...(!local && found.readable ? { record } : {}),
				})
			: Ok(record);
		return { record, result };
	}

	/** Split a patch into fields to set and remove, and check each supplied value. */
	function patchOf(
		path: string,
		given: Record<string, unknown>,
		creating: boolean,
	) {
		const removed: string[] = [];
		const set: FieldValues = {};
		for (const [key, value] of Object.entries(given)) {
			const unknown = unknownField(path, key);
			if (unknown) return unknown;
			if (value === undefined) continue;
			if (value === null && isOptional(fields[key] as TSchema))
				removed.push(key);
			else if (value === null && !creating) {
				return ActionError.Refused({
					message: `${key} is required, so it cannot be removed`,
				});
			} else set[key] = value as JsonValue;
		}
		const problems: string[] = [];
		for (const [key, schema] of Object.entries(fields)) {
			if (Object.hasOwn(set, key)) {
				if (!Value.Check(schema, set[key]))
					problems.push(misfit(key, schema, set[key], local));
			} else if (
				creating &&
				!isOptional(schema) &&
				absentValue(schema) === undefined
			)
				problems.push(`${key} is missing`);
		}
		if (problems.length)
			return ActionError.Refused({
				message: problems.map((problem) => `${path}: ${problem}`).join('\n'),
			});
		return Ok({ set: inDeclaredOrder(set, fields), removed });
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
			return ActionError.Refused({ message: problems.join('\n') });
		return Ok(undefined);
	}

	/** Decide a record and its replacement together, once per attempt at the current file. */
	function write(
		path: string,
		need: Need,
		computed: boolean,
		change: (record: AnyRecord | undefined) => Result<Write, CallbackError>,
	) {
		return folder.edit<AnyRecord, CallbackError>(path, (before) => {
			const single = layout.placeholders.length === 0;
			if (before === undefined && need === 'present' && !single)
				return ActionError.Missing({ path });
			if (before !== undefined && need === 'absent')
				return ActionError.Refused({ message: `${path} is already there` });

			const found = readMarkdown(before ?? '');
			const current =
				before !== undefined || single ? project(path, found) : undefined;
			if (current?.result.error && (computed || !found.readable))
				return current.result;
			const changed = change(current?.record);
			if (changed.error !== null) return changed;
			const { fields: given, body } = changed.data;
			if (body !== undefined && typeof body !== 'string')
				return ActionError.Refused({ message: `${path}: body must be text` });
			const patch = patchOf(path, given, before === undefined);
			if (patch.error !== null) return patch;
			const { set, removed } = patch.data;
			if (
				current &&
				!removed.length &&
				!Object.keys(set).length &&
				body === undefined
			)
				return current.result.error
					? current.result
					: Ok({ value: current.record });

			let after: string;
			if (before === undefined) after = markdownOf(set, body ?? '');
			else {
				const fielded = withFields(before, set, removed);
				after =
					body === undefined
						? fielded
						: fielded.slice(0, fielded.length - found.body.length) + body;
			}
			if (after === before && current)
				return current.result.error
					? current.result
					: Ok({ value: current.record });
			const next = project(path, readMarkdown(after)).result;
			if (next.error !== null)
				return current?.result.error ? current.result : next;
			// A keyless record already reads as its defaults while its file is absent.
			if (
				before === undefined &&
				current &&
				Value.Equal(current.record, next.data)
			)
				return Ok({ value: next.data });
			return Ok({ value: next.data, text: after });
		});
	}

	/** A computed change must explicitly return Ok(change) or Err(error). */
	const computed =
		(change: (record: unknown) => unknown, method: 'set' | 'update') =>
		(now: AnyRecord | undefined): Result<Write, CallbackError> => {
			const result = change(structuredClone(now));
			if (!isActionResult(result))
				throw new Error(
					`The change given to ${method} must return a Result: Ok(change) or Err(error)`,
				);
			if (result.error !== null) return result;
			if (
				typeof result.data !== 'object' ||
				result.data === null ||
				Array.isArray(result.data)
			)
				throw new Error(
					`The change given to ${method} must return a record patch inside Ok`,
				);
			const { body, ...given } = result.data as Record<string, unknown>;
			return Ok({ fields: given, body });
		};

	/** The paths that may be records, each read after: a template with no placeholder is its one path, so its folder is never walked. */
	async function paths() {
		if (!layout.placeholders.length) return [layout.text];
		return (await folder.list(layout.dir || undefined))
			.filter((path) => layout.match(path) !== undefined)
			.sort();
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
	 * differs; `edit` replaces `old` in the body with `new`, refused as
	 * `edited` refuses it. A missing keyed file gives Missing. A missing
	 * keyless file is the empty record and may be created by fields or edit.
	 */
	async function put(
		keys: object,
		given: Record<string, unknown>,
		{
			body,
			was,
			edit,
		}: {
			body?: unknown;
			was?: Record<string, unknown>;
			edit?: Edit;
		},
	) {
		const location = await find(keys);
		if (location.error !== null) return location;
		const { path } = location.data;
		if (
			body === undefined &&
			edit === undefined &&
			Object.values(given).every((value) => value === undefined)
		)
			return ActionError.Refused({
				message: `Nothing to set in ${path}: give a field`,
			});
		for (const key of Object.keys(was ?? {})) {
			const unknown = unknownField(path, key);
			if (unknown) return unknown;
		}
		const checked = await checkReferences(path, given);
		if (checked.error !== null) return checked;
		return write(path, 'present', false, (now) => {
			for (const [key, seen] of Object.entries(was ?? {}))
				if (!Value.Equal(now?.[key] ?? null, seen ?? null))
					return ActionError.Changed({ path, why: 'was' });
			if (!edit) return Ok({ fields: given, body });
			if (!now) return ActionError.Missing({ path });
			const editedBody = edited(path, now.body, edit.old, edit.new);
			if (editedBody.error !== null) return editedBody;
			return Ok({ fields: given, body: editedBody.data });
		});
	}

	return {
		pathOf,
		find,
		put,
		async list() {
			return (await readAll()).map(
				({ path, found }) => project(path, found).result,
			);
		},
		async check() {
			const read = await readAll();
			const records: { path: string; problems: Problem[] }[] = [];
			for (const { path, found } of read) {
				const { error } = project(path, found).result;
				if (error) records.push({ path, problems: error.problems });
			}
			return { files: read.length, records };
		},
		async get(keys: object) {
			const location = await find(keys);
			if (location.error !== null) return location;
			const { path, text } = location.data;
			if (text === undefined && layout.placeholders.length)
				return Ok(undefined);
			return project(path, readMarkdown(text ?? '')).result;
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
			let path: string;
			try {
				path = layout.fill(values);
			} catch (error) {
				return ActionError.Refused({ message: (error as Error).message });
			}
			const checked = await checkReferences(path, given);
			if (checked.error !== null) return checked;
			return write(path, 'absent', false, () => Ok({ fields: given, body }));
		},
		async set(keys: object, change: unknown) {
			if (typeof change === 'function') {
				const location = await find(keys);
				if (location.error !== null) return location;
				return write(
					location.data.path,
					'present',
					true,
					computed(change as (record: unknown) => unknown, 'set'),
				);
			}
			const { body, ...given } = (change ?? {}) as Record<string, unknown>;
			return put(keys, given, { body });
		},
		async update(keys: object, change: (record: unknown) => unknown) {
			const location = await find(keys);
			if (location.error !== null) return location;
			return write(
				location.data.path,
				'either',
				true,
				computed(change, 'update'),
			);
		},
		async delete(keys: object) {
			const found = await find(keys);
			if (found.error !== null) throw new Error(found.error.message);
			const { path, text } = found.data;
			await folder.delete(path);
			return text !== undefined;
		},
	};
}

/** `body` with the passage `old` replaced by `replacement`; returns `Changed` unless `old` is there exactly once, or empty for an empty body. */
function edited(path: string, body: string, old: string, replacement: string) {
	if (old === '') {
		if (body !== '') return ActionError.Changed({ path, why: 'empty' });
		return Ok(replacement);
	}
	const at = body.indexOf(old);
	if (at < 0) return ActionError.Changed({ path, why: 'quote' });
	if (body.indexOf(old, at + 1) >= 0)
		return ActionError.Changed({ path, why: 'twice' });
	return Ok(body.slice(0, at) + replacement + body.slice(at + old.length));
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
	const editIn = Type.Optional(
		Type.Object(
			{
				old: Type.String({
					description:
						'The passage of the body to replace, exactly as get returned it: once in the body, or the whole body, or empty for an empty body',
				}),
				new: Type.String({ description: 'The text to put in its place' }),
			},
			{
				additionalProperties: false,
				description:
					'{ "old": the passage of the body as you last saw it, "new": the text to put in its place }; refused when old is not in the body now',
			},
		),
	);
	const local = { openWorldHint: false } as const;
	/** Refuse a field only the app's own actions write; the runner refuses it first, this guards a direct call. */
	const outside = (input: Record<string, unknown>) => {
		for (const key of Object.keys(input))
			if (def.fields[key] && isReadOnly(def.fields[key]))
				return ActionError.Refused({
					message: `${key} is written only by the app's own actions`,
				});
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
			async () =>
				Ok(
					(await records.list()).map((result) => {
						if (result.error !== null) {
							const { record, ...error } = result.error as Misfit;
							if (!record) return Err(error);
							const { body: _, ...row } = record;
							return Err({ ...error, record: row });
						}
						const { body: _, ...row } = result.data;
						return Ok(row);
					}),
				),
			{
				description: `Every ${what}: one result per file with its path and fields; a file that does not fit its fields is an error beside the rows`,
				input: {},
				annotations: { readOnlyHint: true, ...local },
			},
		),
		get: action(
			async (input) => {
				const found = await records.get(input);
				if (found.error === null && found.data === undefined)
					return ActionError.Missing({ path: records.pathOf(input) });
				return found;
			},
			{
				description: `Read one ${what}: its fields and body; a file that does not fit its fields is an error`,
				input: keysIn,
				annotations: { readOnlyHint: true, ...local },
			},
		),
		add: action((input) => outside(input) ?? records.add(input), {
			description: `Make a new ${what}${keys.includes(TIME) ? ', named by the time' : ''}; refused when one is already at its path`,
			input: addIn,
			annotations: { destructiveHint: false, ...local },
		}),
		set: action(
			(input) => {
				const refused = outside(input);
				if (refused) return refused;
				const { was, edit, ...given } = rest(input);
				const { old, new: replacement } = (edit ?? {}) as Partial<Edit>;
				if (
					edit !== undefined &&
					(typeof old !== 'string' || typeof replacement !== 'string')
				)
					return ActionError.Refused({
						message: `Edit the body of ${layout.text} with edit: { old, new }, each text: old as you last saw it, and new to put in its place`,
					});
				return records.put(input, given, {
					was: was as Record<string, unknown> | undefined,
					edit: edit as Edit | undefined,
				});
			},
			{
				description: `Change one ${what} in one write: the fields given, keeping the rest (null removes one that may be absent), and with edit, the passage edit.old of the body replaced by edit.new. Refused, writing nothing, when ${keyed ? `there is no such ${what}, or ` : ''}when a value in was or edit.old is not what is there now`,
				input: { ...keysIn, ...patchIn, was, edit: editIn },
				annotations: local,
			},
		),
		delete: action(
			async (input) => {
				const found = await records.find(input);
				if (found.error !== null) return found;
				await folder.delete(found.data.path);
				return Ok(found.data.text !== undefined);
			},
			{
				description: `Delete one ${what}; true when there was one`,
				input: keysIn,
				annotations: { idempotentHint: true, ...local },
			},
		),
	};
}
