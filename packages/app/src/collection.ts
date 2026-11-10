/**
 * The four actions every collection gives its app (ADR-0853), with no code.
 * For a collection `items` at `items/{id}.md`:
 *
 * ```txt
 * epicenter capture items list                         every file: its key and fields
 * epicenter capture items get dune                      one file: its key, fields, and body
 * epicenter capture items set dune --kind quote         changes the fields given, keeps the rest and the body
 * epicenter capture items delete dune                   true when a file was there
 * ```
 *
 * They are ordinary actions over the run's `folder`, so the command line, MCP,
 * and a test in memory run the same code. A path with no placeholder (a single
 * `settings.json`) gives only `get` and `set`.
 *
 * A Markdown file's fields are its front matter; a JSON file's fields are its
 * contents. Front matter is read as Epicenter's `key: <JSON>` lines, or else as
 * YAML, and `set` writes `key: <JSON>` lines: it changes only the lines of the
 * fields it sets in a file already written that way, and rewrites YAML front
 * matter as `key: <JSON>`, keeping the body. A file whose front matter is
 * neither is listed and read, its whole text as body, and `set` refuses it.
 *
 * `set` merges as JSON Merge Patch (RFC 7396) does: a field given as `null`
 * is removed, and one not given is kept. It checks its input against the
 * collection's fields before writing, with `format` asserted, and a new file
 * must have every required field. A field a hand edit made wrong is kept;
 * nothing re-checks the fields `set` was not given.
 */
import {
	isFieldKey,
	parseFrontMatter,
	patchFrontMatter,
	stringifyValue,
} from './front-matter.ts';
import { type TSchema, Type } from 'typebox';
import { Value } from 'typebox/value';
import type { Action, Input } from './app.ts';
import type { Context } from './context.ts';
import type { Collection } from './declaration.ts';

type JsonValue = Parameters<typeof stringifyValue>[0];
type Fields = Record<string, JsonValue>;

/** A key names one file: no `/` or `\`, and no leading `.`, so it never climbs out or hides. */
const KEY = '^[^./\\\\][^/\\\\]*$';
const KEY_PATTERN = new RegExp(KEY);

/** A collection's path split around its placeholder, when it has one. */
export function pathTemplate(path: string) {
	const found = /\{([A-Za-z_][A-Za-z0-9_]*)\}/.exec(path);
	if (!found) return undefined;
	const [placeholder, key] = found as unknown as [string, string];
	const before = path.slice(0, found.index);
	const after = path.slice(found.index + placeholder.length);
	const escape = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
	return {
		/** The placeholder's name, which is the key field's. */
		key,
		/** The directory to list: everything before the placeholder, up to its last `/`. */
		dir: before.slice(0, before.lastIndexOf('/') + 1),
		pathOf: (value: string) => `${before}${value}${after}`,
		pattern: new RegExp(`^${escape(before)}([^/]+)${escape(after)}$`),
	};
}

/** How a collection's files hold fields, by the path's extension; `undefined` for any other. */
export function fileKind(path: string): 'markdown' | 'json' | undefined {
	if (path.endsWith('.md')) return 'markdown';
	if (path.endsWith('.json')) return 'json';
	return undefined;
}

type Properties = Record<string, Record<string, unknown>>;

function propertiesOf(collection: Collection): Properties {
	return ((collection.fields as { properties?: Properties }).properties ??
		{}) as Properties;
}

/**
 * What is wrong with a collection beyond its declared shape, one sentence
 * each: its path's extension, and fields named like the key or the body,
 * which `set` takes as its own input.
 */
export function collectionProblems(collection: Collection): string[] {
	const problems: string[] = [];
	const kind = fileKind(collection.path);
	if (kind === undefined)
		problems.push(`has the path ${collection.path}, which is not .md or .json`);
	const template = pathTemplate(collection.path);
	for (const key of Object.keys(propertiesOf(collection))) {
		if (key === template?.key)
			problems.push(
				`has a field "${key}", which its path gives as {${key}}; the file's name holds it`,
			);
		if (kind === 'markdown' && key === 'body')
			problems.push(
				'has a field "body", which is the text after the front matter',
			);
		if (!isFieldKey(key))
			problems.push(
				`has a field ${JSON.stringify(key)}, which a front matter line cannot name`,
			);
	}
	return problems;
}

/** A file's fields and body as read, and whether `set` may rewrite its fields. */
type Read = { fields: Fields; body: string; writable: boolean };

function isRecord(value: unknown): value is Fields {
	return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** A Markdown file's fields: `key: <JSON>` lines, else YAML; else none, and the whole text is body. */
function readMarkdown(text: string): Read {
	const parsed = parseFrontMatter(text);
	if (parsed) return { ...parsed, writable: true };
	const open = /^---\r?\n/.exec(text);
	const rest = open ? text.slice(open[0].length) : '';
	const close = open ? /^---[ \t]*(\r?\n|$)/m.exec(rest) : null;
	if (!open || !close) return { fields: {}, body: text, writable: true };
	try {
		const value = Bun.YAML.parse(rest.slice(0, close.index));
		if (value === null || isRecord(value))
			return {
				fields: value ?? {},
				body: rest.slice(close.index + close[0].length),
				writable: true,
			};
	} catch {}
	return { fields: {}, body: text, writable: false };
}

function readJson(text: string): Read {
	try {
		const value = JSON.parse(text);
		if (isRecord(value)) return { fields: value, body: '', writable: true };
	} catch {}
	return { fields: {}, body: '', writable: false };
}

/** A Markdown file of `fields` as `key: <JSON>` lines, then `body`. */
function markdownOf(fields: Fields, body: string): string {
	const lines = Object.entries(fields).map(
		([key, value]) => `${key}: ${stringifyValue(value)}\n`,
	);
	return `---\n${lines.join('')}---\n${body}`;
}

/** `fields` less the keys in `removed`. */
function without(fields: Fields, removed: string[]): Fields {
	return Object.fromEntries(
		Object.entries(fields).filter(([key]) => !removed.includes(key)),
	);
}

/** `text` with `given` set, `removed` gone, and, when `body` is given, its body replaced. */
function written(
	kind: 'markdown' | 'json',
	text: string | undefined,
	read: Read,
	given: Fields,
	removed: string[],
	body: string | undefined,
): string {
	if (kind === 'json')
		return `${JSON.stringify(without({ ...read.fields, ...given }, removed), null, 2)}\n`;
	const newBody = body ?? read.body;
	if (text !== undefined) {
		const patched = patchFrontMatter(text, { set: given, delete: removed });
		if (patched !== 'outside') {
			if (body === undefined) return patched;
			const kept = parseFrontMatter(patched)?.body ?? '';
			return patched.slice(0, patched.length - kept.length) + newBody;
		}
	}
	return markdownOf(without({ ...read.fields, ...given }, removed), newBody);
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

/** `given`'s keys in the order the collection declares its fields, then the rest. */
function inDeclaredOrder(given: Fields, properties: Properties): Fields {
	const order = Object.keys(properties);
	return Object.fromEntries(
		Object.entries(given).sort(
			([a], [b]) =>
				(order.indexOf(a) + 1 || order.length + 1) -
				(order.indexOf(b) + 1 || order.length + 1),
		),
	);
}

/**
 * The actions collection `name` gives, keyed by their words (`items list`):
 * four for a path with a placeholder, `get` and `set` for one without.
 */
export function collectionActions(
	name: string,
	collection: Collection,
): Record<string, Action> {
	const kind = fileKind(collection.path) ?? 'markdown';
	const template = pathTemplate(collection.path);
	const properties = propertiesOf(collection);
	const schema = collection.fields as TSchema;
	const keyName = template?.key;
	const keyInput: Input = keyName
		? {
				[keyName]: Type.String({
					pattern: KEY,
					description: `Which file: ${collection.path}`,
				}),
			}
		: {};
	const positional = keyName ? [keyName] : [];
	const pathOf = (input: Record<string, unknown>) =>
		template ? template.pathOf(input[template.key] as string) : collection.path;
	const keyOf = (input: Record<string, unknown>) =>
		keyName ? { [keyName]: input[keyName] as string } : {};
	const read = (text: string) =>
		kind === 'json' ? readJson(text) : readMarkdown(text);

	// Every field is optional to `set`, which merges, and `null` removes it; a default would overwrite the file's value, so it applies only to a new file.
	const setInput: Input = { ...keyInput };
	for (const [key, property] of Object.entries(properties)) {
		const { default: _, ...rest } = property;
		setInput[key] = Type.Optional(
			Type.Union([rest as TSchema, Type.Null()], {
				description: rest.description
					? `${rest.description}; null removes it`
					: 'null removes it',
			}),
		);
	}
	if (kind === 'markdown')
		setInput.body = Type.Optional(
			Type.String({
				description: 'The text after the front matter; replaces it',
			}),
		);

	const get: Action = {
		description: `Read one ${name} file: its fields${kind === 'markdown' ? ' and body' : ''}`,
		input: keyInput,
		positional,
		annotations: { readOnlyHint: true, openWorldHint: false },
		async run(input: Record<string, unknown>, { folder }: Context) {
			const path = pathOf(input);
			const text = await folder.read(path);
			if (text === undefined) throw new Error(`There is no ${path}`);
			const { fields, body } = read(text);
			return {
				...fields,
				...keyOf(input),
				...(kind === 'markdown' ? { body } : {}),
			};
		},
	};

	const set: Action = {
		description: `Change the fields given in one ${name} file, keeping the rest${kind === 'markdown' ? ' and the body' : ''}; a field given as null is removed; makes the file when there is none`,
		input: setInput,
		positional,
		annotations: { idempotentHint: true, openWorldHint: false },
		async run(input: Record<string, unknown>, context: Context) {
			const { folder } = context;
			const path = pathOf(input);
			const { body, ...rest } = input;
			if (keyName) delete rest[keyName];
			const removed = Object.keys(rest).filter((key) => rest[key] === null);
			const given = without(rest as Fields, removed);
			const text = await folder.read(path);
			if (text === undefined) {
				for (const [key, property] of Object.entries(properties))
					if (!Object.hasOwn(given, key) && Object.hasOwn(property, 'default'))
						given[key] = structuredClone(property.default) as JsonValue;
				const problem = firstProblem(schema, given);
				if (problem) throw new Error(`A new ${path} ${problem}`);
			}
			const before =
				text === undefined
					? { fields: {}, body: '', writable: true }
					: read(text);
			if (!before.writable)
				throw new Error(
					kind === 'json'
						? `${path} is not a JSON object; fix it by hand first`
						: `${path} has front matter that is neither key: <JSON> lines nor YAML; fix it by hand first`,
				);
			await folder.write(
				path,
				written(
					kind,
					text,
					before,
					inDeclaredOrder(given, properties),
					removed,
					body as string | undefined,
				),
			);
			return get.run(keyOf(input), context);
		},
	};

	if (!template) return { [`${name} get`]: get, [`${name} set`]: set };

	const { dir, pattern, key: listKey } = template;
	const list: Action = {
		description: `Every ${name} file, by ${listKey}, with its fields`,
		input: {},
		annotations: { readOnlyHint: true, openWorldHint: false },
		async run(_: unknown, { folder }: Context) {
			const rows: Fields[] = [];
			for (const path of await folder.list(dir || undefined)) {
				const key = pattern.exec(path)?.[1];
				if (key === undefined || !KEY_PATTERN.test(key)) continue;
				const text = await folder.read(path);
				if (text !== undefined)
					rows.push({ ...read(text).fields, [listKey]: key });
			}
			return rows;
		},
	};

	const remove: Action = {
		description: `Delete one ${name} file; true when there was one`,
		input: keyInput,
		positional,
		annotations: { idempotentHint: true, openWorldHint: false },
		async run(input: Record<string, unknown>, { folder }: Context) {
			const path = pathOf(input);
			const existed = (await folder.read(path)) !== undefined;
			await folder.delete(path);
			return existed;
		},
	};

	return {
		[`${name} list`]: list,
		[`${name} get`]: get,
		[`${name} set`]: set,
		[`${name} delete`]: remove,
	};
}

/** Every collection's actions in a declaration, keyed by their words. */
export function allCollectionActions(
	collections: Readonly<Record<string, Collection>> = {},
): Record<string, Action> {
	return Object.assign(
		{},
		...Object.entries(collections).map(([name, collection]) =>
			collectionActions(name, collection),
		),
	);
}
