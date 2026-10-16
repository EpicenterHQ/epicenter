/**
 * Folder definitions: the shared declaration vocabulary, checked for what a
 * file folder can keep.
 *
 * A folder definition is how a tool reads and edits a folder's files. It names
 * no dataset: the opener is given the folder's ID, so one definition can read
 * several folders and several definitions can read one.
 *
 * A folder stores a row as one Markdown file, and its body is the file's text.
 *
 * A field's editor hint decides nothing here. `field.reference` is a string
 * schema like any other: the folder checks no target, and renaming or
 * deleting a row repairs nothing that names it, so a stored identifier may
 * dangle.
 */
import {
	type DataSchema,
	type DeclaredTable,
	type FieldMap,
	KV_ROOT,
	prepareSchema,
	type ValidateFields,
} from '@epicenter/definition';
import { Err, Ok, type Result } from 'wellcrafted/result';

/** A table a folder can keep: one declared with `defineTable`. */
export type FolderTable = DeclaredTable;

/**
 * Declared and never assigned: the mark exists only in types, so a prepared
 * table is the same plain object at runtime.
 */
declare const PREPARED: unique symbol;

/**
 * A table of a definition `defineFolder` prepared: what `parseRow` and
 * `formatRow` take. Only `defineFolder`'s return type carries the mark, so
 * a raw `defineTable` declaration handed to either is a compile error rather
 * than a call that works until a declared value appears.
 *
 * The mark is a type, not a proof. It survives a spread, so an object built
 * from a prepared table with replaced or cloned `fields` still type-checks,
 * and reading a value through such a field throws, as every read of an
 * unprepared schema does. Keep the prepared objects as `defineFolder` returned
 * them; a changed field or table needs `defineFolder` again.
 */
export type PreparedFolderTable<TTable extends FolderTable = FolderTable> =
	TTable & { readonly [PREPARED]: true };

/**
 * The type `defineFolder` returns: the declared definition with each table
 * marked prepared. The runtime value is the prepared definition itself.
 */
type PreparedFolderDefinition<TDefinition extends FolderDefinition> = {
	readonly [K in keyof TDefinition]: K extends 'tables'
		? {
				readonly [Name in keyof TDefinition['tables']]: TDefinition['tables'][Name] extends FolderTable
					? PreparedFolderTable<TDefinition['tables'][Name]>
					: never;
			}
		: TDefinition[K];
};

/**
 * What a folder reads its files through: a schema that names no dataset.
 *
 * Its `local` patterns name files that stay on the machine that wrote them.
 * Every commit leaves out a path they match, and untracks one already
 * committed, whatever `.gitignore` says (`git/scope.ts`). `epicenter.json`
 * carries them, so every host that reads the folder's own declaration, the
 * `epicenter` CLI included, excludes the same paths. Before its first write
 * a handle also adds each pattern the root `.gitignore` lacks, so plain `git`
 * agrees (`publish-definition.ts`).
 */
export type FolderDefinition = DataSchema & { readonly id?: never };

/**
 * Prepare a definition for file storage, or say why a folder cannot keep it.
 *
 * The result is the prepared definition: the declared shape, holding the
 * frozen schema snapshots a folder reads values through. Preparation is
 * memoized on the declaration and on its result, so an opener handed what
 * `defineFolder` returned gets it back and does no work twice. A definition
 * with an `id`, which only an untyped caller can hand in, is refused.
 */
export function prepareFolderDefinition<TDefinition extends FolderDefinition>(
	definition: TDefinition,
): Result<TDefinition, { readonly reason: string }> {
	const { data: prepared, error: schemaError } = prepareSchema(definition);
	if (schemaError !== null) return Err({ reason: schemaError.message });
	const kvProblem = publicationProblem(KV_ROOT, prepared.kv);
	if (kvProblem !== undefined) return Err({ reason: kvProblem });
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
 * Why one bucket's fields, published together as one object schema in
 * `epicenter.json` (ADR-0517), would resolve their references differently
 * there than each field does alone, or `undefined` when they agree.
 *
 * Each field is validated on its own, but the file holds the bucket as one
 * JSON Schema document. Two things change meaning in that document: an `$id`
 * that two fields define, such as the name of a recursive type, names two
 * schemas, which a JSON Schema validator refuses for the whole table; and a
 * `#` reference outside any `$id` resolves against the table instead of the
 * field. Both are refused rather than rewritten, so the file holds exactly
 * the fields a reader prepares.
 */
function publicationProblem(
	bucket: string,
	fields: FieldMap,
): string | undefined {
	const owners = new Map<string, string>();
	for (const [name, field] of Object.entries(fields)) {
		const where = `'${bucket}.${name}'`;
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
					return `Fields '${bucket}.${owner}' and ${where} both define the $id '${schema.$id}'. epicenter.json holds a table as one JSON Schema, where an $id names one schema; rename one of them.`;
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

/**
 * Declare how a folder's files read without opening anything or naming a
 * folder. Tables use `defineTable` and fields use `field`, the same
 * vocabulary every Epicenter storage declares with.
 *
 * The definition is checked here, where it is written: a malformed schema
 * or an `id` throws at the declaration, not at the first open. What comes back has the declared shape and type, and is the prepared
 * definition: an owned, frozen snapshot of each schema. Its tables are typed
 * {@link PreparedFolderTable}, so `parseRow` and `formatRow` take them.
 */
export function defineFolder<const TDefinition extends DataSchema>(
	schema: TDefinition & {
		kv: ValidateFields<TDefinition['kv']>;
		tables: {
			[Name in keyof TDefinition['tables']]: TDefinition['tables'][Name] extends FolderTable
				? TDefinition['tables'][Name]
				: FolderTable;
		};
		local?: readonly string[];
	} & Record<Exclude<keyof TDefinition, keyof DataSchema | 'local'>, never>,
): PreparedFolderDefinition<
	Pick<TDefinition & Pick<DataSchema, 'title'>, 'title' | 'kv' | 'tables'> &
		Pick<FolderDefinition, 'local'>
> {
	type Definition = Pick<
		TDefinition & Pick<DataSchema, 'title'>,
		'title' | 'kv' | 'tables'
	> &
		Pick<FolderDefinition, 'local'>;
	if (Object.hasOwn(schema, 'id'))
		throw new Error(
			'A folder definition names no folder. Pass the folder ID to openFolder instead.',
		);
	// The types refuse other keys; an untyped caller, such as a generated
	// epicenter.ts, is refused here rather than having a misspelling dropped.
	const unknown = Object.keys(schema).filter(
		(key) =>
			key !== 'title' && key !== 'kv' && key !== 'tables' && key !== 'local',
	);
	if (unknown.length > 0)
		throw new Error(
			`A folder definition declares title, kv, tables, and local; it also declares ${unknown.map((key) => `'${key}'`).join(', ')}`,
		);
	const { title, kv, tables, local } = schema;
	const declaration: Definition = {
		...(title === undefined ? {} : { title }),
		kv,
		tables,
		...(local === undefined ? {} : { local }),
	};
	const { data: prepared, error: definitionError } =
		prepareFolderDefinition(declaration);
	if (definitionError !== null) throw new Error(definitionError.reason);
	// The mark is a type alone: the prepared definition is returned as it is.
	return prepared as PreparedFolderDefinition<Definition>;
}
