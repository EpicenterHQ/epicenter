/**
 * Generator authoring: defineFolder prepares the named declaration exported
 * by epicenter.ts. The CLI serializes its fields as complete table schemas.
 * Applications opening a Folder supply native TypeBox schemas directly.
 *
 * A folder definition is how a tool reads a folder's files. It names no
 * dataset, so one definition can read several folders and several
 * definitions can read one.
 *
 * A folder stores a row as one Markdown file, and its body is the file's text.
 *
 * A field's editor hint decides nothing here. `field.reference` is a string
 * schema like any other: the folder checks no target, and renaming or
 * deleting a row repairs nothing that names it, so a stored identifier may
 * dangle.
 */
import {
	type CreateRowOf,
	type DeclaredTable,
	type Definition,
	type FieldMap,
	isOptional,
	prepareDefinition,
	SETTINGS_TABLE,
} from '@epicenter/definition';
import { Err, Ok, type Result } from 'wellcrafted/result';

/**
 * What a folder reads its files through: a definition that names no dataset.
 */
export type { Definition };

/**
 * Prepare a definition for file storage, or say why a folder cannot keep it.
 *
 * The result is the prepared definition: the given structure, holding the
 * frozen schema snapshots the generator serializes. Preparation is memoized
 * on the definition and its result, so repeated preparation reuses it. A definition
 * with a key besides `title` and `tables`, which only an untyped
 * caller can hand in, is refused.
 */
export function prepareFolderDefinition<TDefinition extends Definition>(
	definition: TDefinition,
): Result<TDefinition, { readonly reason: string }> {
	const { data: prepared, error: schemaError } = prepareDefinition(definition);
	if (schemaError !== null) return Err({ reason: schemaError.message });
	for (const [name, table] of Object.entries(prepared.tables)) {
		const problem = publicationProblem(name, table.fields);
		if (problem !== undefined) return Err({ reason: problem });
	}
	return Ok(prepared);
}

/** Keywords whose value is data, never a schema. */
const DATA_KEYWORDS = new Set(['default', 'const', 'enum', 'examples']);
/** Keywords whose value maps names to schemas. */
const SCHEMA_MAP_KEYWORDS = new Set([
	'properties',
	'patternProperties',
	'$defs',
	'definitions',
	'dependentSchemas',
	'dependencies',
]);
/** The base TypeBox resolves an `$id` against when nothing encloses it. */
const NO_BASE = 'http://unknown/';

/**
 * Why one table's fields, published together as one object schema in
 * `epicenter.json` (ADR-0517), would resolve their references differently
 * there than each field does alone, or `undefined` when they agree.
 *
 * Each field is validated on its own, but the file holds the table as one
 * JSON Schema document. Two things change meaning in that document: an `$id`
 * that two fields define, such as the name of a recursive type, names two
 * schemas, which a JSON Schema validator refuses for the whole table; and a
 * `#` reference outside any `$id` resolves against the table instead of the
 * field. Both are refused rather than rewritten, so the file holds exactly
 * the fields a reader prepares.
 */
function publicationProblem(
	table: string,
	fields: FieldMap,
): string | undefined {
	const owners = new Map<string, string>();
	for (const [name, field] of Object.entries(fields)) {
		const where = `'${table}.${name}'`;
		const visit = (
			node: unknown,
			base: string | undefined,
		): string | undefined => {
			if (typeof node !== 'object' || node === null) return undefined;
			if (Array.isArray(node)) {
				for (const item of node) {
					const problem = visit(item, base);
					if (problem !== undefined) return problem;
				}
				return undefined;
			}
			const schema = node as Record<string, unknown>;
			let scope = base;
			if (typeof schema.$id === 'string') {
				scope = resolved(schema.$id, base);
				const owner = owners.get(scope);
				if (owner === name)
					return `Field ${where} defines the $id '${schema.$id}' twice. epicenter.json holds a table as one JSON Schema, where an $id names one schema; rename one of them.`;
				if (owner !== undefined)
					return `Fields '${table}.${owner}' and ${where} both define the $id '${schema.$id}'. epicenter.json holds a table as one JSON Schema, where an $id names one schema; rename one of them.`;
				owners.set(scope, name);
			}
			if (
				typeof schema.$ref === 'string' &&
				schema.$ref.startsWith('#') &&
				scope === undefined
			)
				return `Field ${where} refers to '${schema.$ref}' outside any $id. In epicenter.json '#' is the whole table, not the field; give the field an $id.`;
			for (const [key, value] of Object.entries(schema)) {
				if (DATA_KEYWORDS.has(key)) continue;
				const children =
					SCHEMA_MAP_KEYWORDS.has(key) &&
					typeof value === 'object' &&
					value !== null &&
					!Array.isArray(value)
						? Object.values(value)
						: [value];
				for (const child of children) {
					const problem = visit(child, scope);
					if (problem !== undefined) return problem;
				}
			}
			return undefined;
		};
		const problem = visit(field, undefined);
		if (problem !== undefined) return problem;
	}
	return undefined;
}

/** An `$id` as an absolute URI against its enclosing one, as TypeBox reads it. */
function resolved(id: string, base: string | undefined): string {
	try {
		return new URL(id, base ?? NO_BASE).href;
	} catch {
		return id;
	}
}

/** The fields a row of `TTable` cannot leave out. */
type RequiredFields<TTable extends DeclaredTable> = {
	[K in keyof CreateRowOf<TTable>]-?: object extends Pick<
		CreateRowOf<TTable>,
		K
	>
		? never
		: K;
}[keyof CreateRowOf<TTable>];

/**
 * A declared table as `defineFolder` takes it under `name`. The `settings`
 * table's fields are all `field.optional`, as preparation requires, so a
 * required one is refused at the table with the field's name.
 */
type TableUnder<TName, TTable> = TTable extends DeclaredTable
	? TName extends typeof SETTINGS_TABLE
		? TTable & {
				readonly fields: {
					readonly [K in RequiredFields<TTable>]: `'${K & string}' is a setting, which may be unset: declare it with field.optional(...)`;
				};
			}
		: TTable
	: DeclaredTable;

/**
 * Define how a folder's files read without opening anything or naming a
 * folder. Tables use `defineTable` and fields use `field`, the same
 * vocabulary every Epicenter storage declares with.
 *
 * The definition is checked here, where it is written: a malformed schema
 * or a key besides `title` and `tables`, such as an `id`, throws at
 * the definition, before generation writes anything. What comes back has the given
 * structure and type, and is the prepared definition: an owned, frozen
 * snapshot of each schema. `epicenter generate` serializes that snapshot.
 */
export function defineFolder<const TDefinition extends Definition>(
	schema: TDefinition & {
		tables: {
			[Name in keyof TDefinition['tables']]: TableUnder<
				Name,
				TDefinition['tables'][Name]
			>;
		};
	} & Record<Exclude<keyof TDefinition, keyof Definition>, never>,
): Pick<TDefinition & Pick<Definition, 'title'>, 'title' | 'tables'> {
	type Defined = Pick<
		TDefinition & Pick<Definition, 'title'>,
		'title' | 'tables'
	>;
	// The types refuse other keys, an `id` included: a definition names no
	// folder. An untyped caller, such as a generated epicenter.ts, is refused
	// here rather than having a misspelling dropped.
	const unknown = Object.keys(schema).filter(
		(key) => key !== 'title' && key !== 'tables',
	);
	if (unknown.length > 0)
		throw new Error(
			`A folder definition declares title and tables; it also declares ${unknown.map((key) => `'${key}'`).join(', ')}`,
		);
	const { title, tables } = schema;
	const settings = (tables as Record<string, DeclaredTable>)[SETTINGS_TABLE];
	for (const [name, declared] of Object.entries(settings?.fields ?? {}))
		if (!isOptional(declared as never))
			throw new Error(
				`'${name}' is a setting, which may be unset: declare it with field.optional(...)`,
			);
	const defined: Defined = {
		...(title === undefined ? {} : { title }),
		tables,
	};
	const { data: prepared, error: definitionError } =
		prepareFolderDefinition(defined);
	if (definitionError !== null) throw new Error(definitionError.reason);
	return prepared;
}
