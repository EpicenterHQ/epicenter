/**
 * `epicenter.json`: a data folder's declaration as JSON Schema (ADR-0517).
 *
 * Each table is one object schema, `{ type: 'object', properties, required }`,
 * whose properties are the table's fields exactly as a prepared definition
 * holds them. `kv` is the same without `required`, since every setting may be
 * unset. Each field is ordinary JSON Schema plus an `x-field` editor hint, so
 * a tool can check a row's values field by field without knowing Epicenter,
 * as Epicenter itself does.
 *
 * ```json
 * {
 *   "title": "Vault",
 *   "kv": { "type": "object", "properties": { "theme": { "enum": ["light", "dark"] } } },
 *   "tables": {
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
 * `field.optional`. The two convert here and nowhere else. A top-level
 * `$schema` lets an editor offer completion and is not interpreted. Anything
 * else is refused, so a misspelled key never reads as an empty declaration.
 */

import { type FieldMap, field, isOptional } from '@epicenter/definition';
import { Err, Ok, type Result } from 'wellcrafted/result';
import type { FolderStorage } from './boundary.js';
import {
	type FolderDefinition,
	prepareFolderDefinition,
} from './definition.js';
import { DECLARATION_PATH } from './paths.js';

/** The text an opener publishes for a prepared definition. */
export function formatDeclaration(definition: FolderDefinition): string {
	const tables: Record<string, unknown> = {};
	for (const [name, table] of Object.entries(definition.tables))
		tables[name] = {
			type: 'object',
			properties: table.fields,
			required: Object.keys(table.fields).filter(
				(key) => !isOptional(table.fields[key]!),
			),
		};
	return `${JSON.stringify(
		{
			...(definition.title === undefined ? {} : { title: definition.title }),
			kv: { type: 'object', properties: definition.kv },
			tables,
		},
		null,
		2,
	)}\n`;
}

/**
 * Read declaration text into a definition for `prepareFolderDefinition`, or
 * say why the text is not one. Field schemas are checked when the result is
 * prepared, not here.
 */
export function parseDeclaration(
	text: string,
): Result<FolderDefinition, { readonly reason: string }> {
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
	const unknown = unknownKeys(declared, ['$schema', 'title', 'kv', 'tables']);
	if (unknown !== undefined)
		return refuse(
			`unknown top-level key ${unknown}; expected title, kv, tables, or $schema`,
		);

	const kv = objectSchema(declared.kv, 'kv', false);
	if (kv.error !== null) return kv;
	if (!isPlainObject(declared.tables))
		return refuse("'tables' must map table names to object schemas");
	// Without a prototype, so a table named `__proto__` is an entry that
	// preparation refuses by name.
	const tables: Record<string, { fields: FieldMap }> = Object.create(null);
	for (const [name, table] of Object.entries(declared.tables)) {
		const fields = objectSchema(table, `tables.${name}`, true);
		if (fields.error !== null) return fields;
		tables[name] = { fields: fields.data };
	}
	return Ok({
		...(declared.title === undefined
			? {}
			: { title: declared.title as string }),
		kv: kv.data,
		tables,
	} as FolderDefinition);
}

const utf8 = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true });

/**
 * Read a folder's own `epicenter.json` through `storage` and prepare it, as
 * `readFolder` and `openDataFolder` both do: `undefined` when the folder has
 * none, or why the file cannot be used. It writes nothing.
 */
export async function readDeclaration(
	storage: Pick<FolderStorage, 'read'>,
): Promise<Result<FolderDefinition | undefined, { readonly reason: string }>> {
	const { data: read, error: readError } = await storage.read(DECLARATION_PATH);
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
	const { data: declared, error: parseError } = parseDeclaration(text);
	if (parseError !== null) return Err(parseError);
	return prepareFolderDefinition(declared);
}

/**
 * The fields an object schema declares: each property, made optional unless
 * `required` names it. KV has no `required`: every setting is optional.
 */
function objectSchema(
	value: unknown,
	at: string,
	table: boolean,
): Result<FieldMap, { readonly reason: string }> {
	const refuse = (reason: string) => Err({ reason: `'${at}' ${reason}` });
	if (!isPlainObject(value)) return refuse('must be an object schema');
	const unknown = unknownKeys(
		value,
		table ? ['type', 'properties', 'required'] : ['type', 'properties'],
	);
	if (unknown !== undefined)
		return refuse(
			`has unknown key ${unknown}; expected type, properties${table ? ', or required' : ''}`,
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
		fields[name] =
			!table || required.includes(name) ? schema : field.optional(schema);
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
