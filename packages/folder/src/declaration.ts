/**
 * `epicenter.json`: a folder's definition as JSON Schema (ADR-0517).
 *
 * The CLI's `check` and `query` read the root file's tables (ADR-0632). A
 * person or a schema distribution installs it; opening a `Folder` neither
 * reads nor writes it. The older `epicenter generate` still writes it from a
 * folder's `epicenter.ts` (ADR-0527) until its callers migrate. Every written
 * file has `tables`, even when empty, so a reader never guesses at a missing
 * section.
 *
 * Each table is one object schema, `{ type: 'object', properties, required }`,
 * whose properties are the table's fields exactly as a prepared definition
 * holds them. A closed table adds `"additionalProperties": false`, so a row
 * with an undeclared key does not conform, exactly as JSON Schema reads it.
 * Settings are a table too, `settings`, whose fields are all optional, so
 * none is `required`. Each field is ordinary JSON Schema plus an `x-field`
 * editor hint, so a tool can check a row's values field by field without
 * knowing Epicenter, as Epicenter itself does.
 *
 * ```json
 * {
 *   "title": "Vault",
 *   "tables": {
 *     "settings": { "type": "object", "properties": { "theme": { "enum": ["light", "dark"] } }, "required": [] },
 *     "pages": {
 *       "type": "object",
 *       "properties": { "title": { "type": "string" }, "queuedAt": { "type": "string", "format": "date" } },
 *       "required": ["title"]
 *     }
 *   }
 * }
 * ```
 *
 * `required` is the one optionality marker in the file; in memory it is
 * `field.optional`. The two convert here and nowhere else.
 *
 * A folder that keeps files on the machine that wrote them adds
 * `"local": ["audio/"]`, its `.gitignore` patterns (ADR-0577). The folder's
 * own file is what the `epicenter` CLI's history reads (`parseLocalPolicy`),
 * so it leaves the same paths out of every commit whatever app wrote them.
 * That reading needs no `tables`: `{"local": ["audio/"]}` is a whole policy.
 * A file without `local` keeps nothing local.
 *
 * A top-level `$schema` lets an editor offer completion and is not
 * interpreted. Anything else is refused, so a misspelled key never reads as
 * an empty definition.
 */

import { type FieldMap, field, isOptional } from '@epicenter/definition';
import { Err, Ok, type Result } from 'wellcrafted/result';
import type { FolderStorage } from './boundary.js';
import { type Definition, prepareFolderDefinition } from './definition.js';
import { localMatcher } from './git/scope.js';
import { DEFINITION_PATH } from './paths.js';

/** The `epicenter.json` text of a prepared definition. */
export function formatDefinition(definition: Definition): string {
	const tables: Record<string, unknown> = {};
	for (const [name, table] of Object.entries(definition.tables))
		tables[name] = {
			type: 'object',
			properties: table.fields,
			required: Object.keys(table.fields).filter(
				(key) => !isOptional(table.fields[key]!),
			),
			...(table.additionalProperties === false
				? { additionalProperties: false }
				: {}),
		};
	return `${JSON.stringify(
		{
			...(definition.title === undefined ? {} : { title: definition.title }),
			...(definition.local === undefined ? {} : { local: definition.local }),
			tables,
		},
		null,
		2,
	)}\n`;
}

const utf8 = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true });

/** The top-level keys an `epicenter.json` may hold. */
const TOP_LEVEL_KEYS = ['$schema', 'title', 'local', 'tables'];

/**
 * The `local` patterns of `epicenter.json`'s bytes, read as a directory's Git
 * history reads them to decide what stays on this computer: none when the
 * file lists none, or why the file says nothing usable.
 *
 * Only `local` is interpreted. `tables` and `title` are an app's, to read
 * files with, so a table schema no app can prepare does not stop history.
 * The file is still read whole and strictly: UTF-8 JSON, an object whose
 * every key is one `epicenter.json` declares, so a misspelled `Local` never
 * reads as an empty list, and each pattern one ignoring `.gitignore` line:
 * no comment, no negation, nothing empty, no second line, no surrounding
 * whitespace. No pattern may match `epicenter.json` itself: the file that
 * says what stays local goes with every commit.
 */
export function parseLocalPolicy(
	bytes: Uint8Array,
): Result<readonly string[], { readonly reason: string }> {
	const refuse = (reason: string) => Err({ reason });
	let text: string;
	try {
		text = utf8.decode(bytes);
	} catch {
		return refuse('it is not UTF-8 text');
	}
	let declared: unknown;
	try {
		declared = JSON.parse(text);
	} catch (cause) {
		return refuse(
			`it is not JSON (${cause instanceof Error ? cause.message : String(cause)})`,
		);
	}
	if (!isPlainObject(declared)) return refuse('it is not a JSON object');
	const unknown = unknownKeys(declared, TOP_LEVEL_KEYS);
	if (unknown !== undefined)
		return refuse(
			`unknown top-level key ${unknown}; expected local, tables, title, or $schema`,
		);
	const { local } = declared;
	if (local === undefined) return Ok([]);
	if (!Array.isArray(local))
		return refuse("'local' must list .gitignore patterns");
	for (const pattern of local as unknown[]) {
		if (typeof pattern !== 'string' || pattern === '')
			return refuse("each 'local' pattern must be a nonempty string");
		const quoted = JSON.stringify(pattern);
		if (/[\r\n]/.test(pattern))
			return refuse(`the local pattern ${quoted} must be one line`);
		if (pattern.trim() !== pattern)
			return refuse(`the local pattern ${quoted} has surrounding whitespace`);
		if (pattern.startsWith('#') || pattern.startsWith('!'))
			return refuse(
				`the local pattern ${quoted} must keep files local; it cannot be a comment or a negation`,
			);
		if (localMatcher([pattern])(DEFINITION_PATH))
			return refuse(
				`the local pattern ${quoted} matches ${DEFINITION_PATH} itself, which every commit must carry; narrow it`,
			);
	}
	return Ok(Object.freeze([...(local as string[])]));
}

/**
 * Read a folder's own `epicenter.json` through `storage` as its Git history
 * does (`parseLocalPolicy`): its `local` patterns, `undefined` when the
 * folder has none, or why the file cannot be used. It writes nothing.
 */
export async function readLocalPolicy(
	storage: Pick<FolderStorage, 'read'>,
): Promise<Result<readonly string[] | undefined, { readonly reason: string }>> {
	const { data: read, error } = await storage.read(DEFINITION_PATH);
	if (error !== null)
		return error.name === 'NotFound'
			? Ok(undefined)
			: Err({ reason: error.message });
	return parseLocalPolicy(read.bytes);
}

/**
 * Read `epicenter.json` text into a definition for `prepareFolderDefinition`, or
 * say why the text is not one. Field schemas are checked when the result is
 * prepared, not here.
 */
export function parseDefinition(
	text: string,
): Result<Definition, { readonly reason: string }> {
	const refuse = (reason: string) => Err({ reason });
	let declared: unknown;
	try {
		declared = JSON.parse(text);
	} catch (cause) {
		return refuse(
			`it is not JSON (${cause instanceof Error ? cause.message : String(cause)})`,
		);
	}
	if (!isPlainObject(declared)) return refuse('it is not a JSON object');
	const unknown = unknownKeys(declared, TOP_LEVEL_KEYS);
	if (unknown !== undefined)
		return refuse(
			`unknown top-level key ${unknown}; expected title, local, tables, or $schema`,
		);
	// The patterns themselves are checked when the result is prepared.
	const { local } = declared;
	if (
		local !== undefined &&
		(!Array.isArray(local) ||
			local.some((pattern) => typeof pattern !== 'string'))
	)
		return refuse("'local' must list .gitignore patterns as strings");

	if (declared.tables === undefined)
		return refuse(
			"it has no 'tables'; every generated definition has them, so define the folder in epicenter.ts and run `epicenter generate`",
		);
	if (!isPlainObject(declared.tables))
		return refuse("'tables' must map table names to object schemas");
	// Without a prototype, so a table named `__proto__` is an entry that
	// preparation refuses by name.
	const tables: Record<
		string,
		{ fields: FieldMap; additionalProperties?: false }
	> = Object.create(null);
	for (const [name, table] of Object.entries(declared.tables)) {
		const fields = objectSchema(table, `tables.${name}`);
		if (fields.error !== null) return fields;
		const { additionalProperties } = table as Record<string, unknown>;
		if (additionalProperties !== undefined && additionalProperties !== false)
			return refuse(
				`'tables.${name}' declares "additionalProperties"; the only value is false, which closes the table`,
			);
		tables[name] = {
			fields: fields.data,
			...(additionalProperties === false
				? { additionalProperties: false as const }
				: {}),
		};
	}
	return Ok({
		...(declared.title === undefined
			? {}
			: { title: declared.title as string }),
		...(local === undefined ? {} : { local: local as string[] }),
		tables,
	} as Definition);
}

/**
 * Read a folder's own `epicenter.json` through `storage` and prepare it, as
 * `readFolder` does: `undefined` when the folder has none, or
 * why the file cannot be used. It writes nothing.
 */
export async function readDefinition(
	storage: Pick<FolderStorage, 'read'>,
): Promise<Result<Definition | undefined, { readonly reason: string }>> {
	const { data: read, error: readError } = await storage.read(DEFINITION_PATH);
	if (readError !== null)
		return readError.name === 'NotFound'
			? Ok(undefined)
			: Err({ reason: readError.message });
	let text: string;
	try {
		text = utf8.decode(read.bytes);
	} catch {
		return Err({ reason: 'it is not UTF-8 text' });
	}
	const { data: declared, error: parseError } = parseDefinition(text);
	if (parseError !== null) return Err(parseError);
	return prepareFolderDefinition(declared);
}

/**
 * The fields a table's object schema declares: each property, made optional
 * unless `required` names it.
 */
function objectSchema(
	value: unknown,
	at: string,
): Result<FieldMap, { readonly reason: string }> {
	const refuse = (reason: string) => Err({ reason: `'${at}' ${reason}` });
	if (!isPlainObject(value)) return refuse('must be an object schema');
	const unknown = unknownKeys(value, [
		'type',
		'properties',
		'required',
		'additionalProperties',
	]);
	if (unknown !== undefined)
		return refuse(
			`has unknown key ${unknown}; expected type, properties, required, or additionalProperties`,
		);
	if (value.type !== 'object') return refuse('must say "type": "object"');
	const { properties } = value;
	if (!isPlainObject(properties))
		return refuse('must map field names to schemas in "properties"');
	const required = value.required ?? [];
	if (
		!Array.isArray(required) ||
		required.some((name) => typeof name !== 'string') ||
		new Set(required).size !== required.length
	)
		return refuse('"required" must list field names once each');
	for (const name of required as string[])
		if (!Object.hasOwn(properties, name))
			return refuse(`requires '${name}', which "properties" does not declare`);
	const fields: Record<string, FieldMap[string]> = Object.create(null);
	for (const [name, schema] of Object.entries(properties)) {
		if (!isPlainObject(schema))
			return refuse(`declares '${name}' as something other than a schema`);
		// `~` keys are TypeBox's, never JSON Schema; optionality is `required`.
		const marker = Object.keys(schema).find((key) => key.startsWith('~'));
		if (marker !== undefined)
			return refuse(
				`declares '${name}' with '${marker}', which is not JSON Schema; list required fields in "required"`,
			);
		fields[name] = required.includes(name) ? schema : field.optional(schema);
	}
	return Ok(fields);
}

/** The first key outside `allowed`, quoted, or `undefined`. */
function unknownKeys(
	value: Record<string, unknown>,
	allowed: readonly string[],
): string | undefined {
	const extra = Object.keys(value).filter((key) => !allowed.includes(key));
	return extra.length === 0
		? undefined
		: extra.map((key) => `'${key}'`).join(', ');
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
	return typeof value === 'object' && value !== null && !Array.isArray(value);
}
