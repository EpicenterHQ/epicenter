/**
 * `<table>/.epicenter.json`: one table's schema, as JSON Schema.
 *
 * A folder's tables are its top-level directories that hold a
 * `.epicenter.json` (`SCHEMA_FILE`); a directory without one is plain files,
 * never a table, and nothing at the folder's root declares anything. Each
 * file is one object schema, `{ type: 'object', properties, required }`,
 * whose properties are the table's fields exactly as a prepared definition
 * holds them. A closed table adds `"additionalProperties": false`, so a row
 * with an undeclared key does not conform, exactly as JSON Schema reads it.
 * Settings are a table too, `settings/.epicenter.json`, whose fields are all
 * optional, so none is `required`. Each field is ordinary JSON Schema plus an
 * `x-field` editor hint, so a tool can check a row's values field by field
 * without knowing Epicenter, as Epicenter itself does.
 *
 * ```json
 * // pages/.epicenter.json
 * {
 *   "type": "object",
 *   "properties": { "title": { "type": "string" }, "queuedAt": { "type": "string", "format": "date" } },
 *   "required": ["title"]
 * }
 * ```
 *
 * `required` is the one optionality marker in the file; in memory it is
 * `field.optional`. The two convert here and nowhere else.
 *
 * A top-level `$schema` lets an editor offer completion and is not
 * interpreted. Anything else is refused, so a misspelled key never reads as
 * an empty table. What stays on one machine is the folder's `.gitignore`
 * (ADR-0592), and a folder carries no title: neither is in a schema file.
 */

import {
	type DeclaredTable,
	type FieldMap,
	field,
	isOptional,
} from '@epicenter/definition';
import { Err, Ok, type Result } from 'wellcrafted/result';
import type { FolderStorage } from './boundary.js';
import { type Definition, prepareFolderDefinition } from './definition.js';
import { schemaPath, tableOfSchemaPath } from './paths.js';

/** One table's schema file text, as an opener publishes it. */
export function formatTableSchema(table: DeclaredTable): string {
	return `${JSON.stringify(
		{
			type: 'object',
			properties: table.fields,
			required: Object.keys(table.fields).filter(
				(key) => !isOptional(table.fields[key]!),
			),
			...(table.additionalProperties === false
				? { additionalProperties: false }
				: {}),
		},
		null,
		2,
	)}\n`;
}

/**
 * The schema files a definition publishes: each table's text by its
 * `<table>/.epicenter.json` path. A definition's `title` and `local` are not
 * in any file.
 */
export function formatDefinition(
	definition: Definition,
): Readonly<Record<string, string>> {
	const files: Record<string, string> = {};
	for (const [name, table] of Object.entries(definition.tables))
		files[schemaPath(name)] = formatTableSchema(table);
	return Object.freeze(files);
}

/** A table as one schema file declares it, before preparation. */
type ParsedTable = { fields: FieldMap; additionalProperties?: false };

/**
 * Read one `.epicenter.json`'s text into a table declaration, or say why the
 * text is not one. Field schemas are checked when the definition holding
 * it is prepared, not here.
 */
export function parseTableSchema(
	text: string,
): Result<ParsedTable, { readonly reason: string }> {
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
	const { $schema: _editorHint, ...schema } = declared;
	const fields = objectSchema(schema);
	if (fields.error !== null) return fields;
	const { additionalProperties } = schema;
	if (additionalProperties !== undefined && additionalProperties !== false)
		return refuse(
			'it declares "additionalProperties"; the only value is false, which closes the table',
		);
	return Ok({
		fields: fields.data,
		...(additionalProperties === false
			? { additionalProperties: false as const }
			: {}),
	});
}

/**
 * Read schema files, each by its `<table>/.epicenter.json` path, into a
 * definition for `prepareFolderDefinition`, or say which file is not one and
 * why. A path that is not a top-level table's schema file is refused.
 */
export function parseDefinition(
	files: Readonly<Record<string, string>>,
): Result<Definition, { readonly reason: string; readonly path: string }> {
	// Without a prototype, so a table named `__proto__` is an entry that
	// preparation refuses by name.
	const tables: Record<string, ParsedTable> = Object.create(null);
	for (const [path, text] of Object.entries(files)) {
		const name = tableOfSchemaPath(path);
		if (name === undefined)
			return Err({
				path,
				reason: `'${path}' is not a table's schema file, <table>/.epicenter.json`,
			});
		const { data: table, error } = parseTableSchema(text);
		if (error !== null) return Err({ path, reason: error.reason });
		tables[name] = table;
	}
	return Ok({ tables } as unknown as Definition);
}

const utf8 = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true });

/**
 * Discover a folder's tables through `storage` and prepare them, as
 * `readFolder` does and `openFolder` does for any folder but an app's own:
 * every top-level directory holding a `.epicenter.json` is a table, read
 * from that file. A folder with none has no tables. A schema file that
 * cannot be used is the error, naming its path; a root that cannot be
 * listed names the path `''`. It writes nothing.
 */
export async function readDefinition(
	storage: Pick<FolderStorage, 'read' | 'children'>,
): Promise<
	Result<Definition, { readonly reason: string; readonly path: string }>
> {
	const { data: root, error: listError } = await storage.children('');
	// The root itself could not be listed: no file is to blame.
	if (listError !== null) return Err({ path: '', reason: listError.message });
	const files: Record<string, string> = {};
	for (const directory of root.directories) {
		const path = schemaPath(directory);
		const { data: read, error: readError } = await storage.read(path);
		if (readError !== null) {
			// A directory with no schema file is not a table.
			if (readError.name === 'NotFound') continue;
			return Err({ path, reason: readError.message });
		}
		try {
			files[path] = utf8.decode(read.bytes);
		} catch {
			return Err({ path, reason: 'it is not UTF-8 text' });
		}
	}
	const { data: declared, error: parseError } = parseDefinition(files);
	if (parseError !== null) return Err(parseError);
	const { data: prepared, error: prepareError } =
		prepareFolderDefinition(declared);
	if (prepareError === null) return Ok(prepared);
	// Name the file whose table cannot be prepared on its own.
	const names = Object.keys(declared.tables);
	const blamed =
		names.find(
			(name) =>
				prepareFolderDefinition({
					tables: { [name]: declared.tables[name]! },
				} as Definition).error !== null,
		) ?? names[0]!;
	return Err({ path: schemaPath(blamed), reason: prepareError.reason });
}

/**
 * The fields a table's object schema declares: each property, made optional
 * unless `required` names it.
 */
function objectSchema(
	value: Record<string, unknown>,
): Result<FieldMap, { readonly reason: string }> {
	const refuse = (reason: string) => Err({ reason: `the schema ${reason}` });
	const unknown = unknownKeys(value, [
		'type',
		'properties',
		'required',
		'additionalProperties',
	]);
	if (unknown !== undefined)
		return refuse(
			`has unknown key ${unknown}; expected type, properties, required, additionalProperties, or $schema`,
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
