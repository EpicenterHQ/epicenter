/**
 * An app's lens over a repository, the pure half of `defineApp`. It maps
 * identifier names to path templates, each with a schema (a Markdown note)
 * or `blob: true` (any other file, whose bytes go through Git LFS), refuses
 * an app whose templates could claim one file, derives per name the SQL
 * view a device creates on open, and checks a text against a name's schema
 * (`app.check`) without a repository.
 */
import type { TSchema } from 'typebox';
import { Check, Errors } from 'typebox/value';
import { isNote } from './door.js';
import { parseMarkdown } from './markdown.js';
import {
	compileTemplate,
	IDENTIFIER,
	matchTemplate,
	type Template,
	templateEnds,
	templatesOverlap,
} from './templates.js';

/**
 * A collection of Markdown notes. `memory: false`: the page does not keep
 * it in memory, so it reads one note at a time and through SQL, for a
 * collection too large to hold; by default a page keeps every note whole.
 */
export type NoteDefinition = { path: string; schema: TSchema; memory?: false };
/**
 * A collection of blobs: files named by the app (`recordings/{stem}.webm`),
 * kept in the repository as Git LFS pointers. Its template must not end in
 * `.md`: a Markdown file is always a note.
 */
export type BlobDefinition = { path: string; blob: true };
export type Definitions = Record<string, NoteDefinition | BlobDefinition>;

/** The names of an app's note templates, as opposed to its blob templates. */
export type NoteName<TDefs extends Definitions> = {
	[K in keyof TDefs]: TDefs[K] extends { schema: TSchema } ? K : never;
}[keyof TDefs] &
	string;

/** The names of an app's blob templates. */
export type BlobName<TDefs extends Definitions> = {
	[K in keyof TDefs]: TDefs[K] extends { blob: true } ? K : never;
}[keyof TDefs] &
	string;

/** Names the repository object itself uses, so no handle can shadow them. */
const RESERVED = new Set([
	'status',
	'subscribe',
	'commit',
	'revision',
	'batch',
	'send',
	'verdict',
	'notices',
	'files',
	'live',
	'query',
	'flush',
	'close',
	'app',
]);

/** Columns every view has, so no parameter or field may take their names. */
const VIEW_COLUMNS = new Set(['path', 'body', 'oid', 'size']);

export type Lens =
	| {
			kind: 'note';
			name: string;
			template: Template;
			schema: TSchema;
			fields: string[];
			view: string;
			/** Whether a page keeps every note of it in memory. */
			memory: boolean;
	  }
	| {
			kind: 'blob';
			name: string;
			template: Template;
			view: string;
	  };

/**
 * Define an app. Throws on a bad name, a bad template, a column collision or
 * two templates that could claim the same file: these are mistakes in the
 * app's source, found when it is loaded, not runtime conditions.
 */
export function defineApp<const TDefs extends Definitions>(definitions: TDefs) {
	const lenses = Object.entries(definitions).map(([name, definition]) => lensOf(name, definition));
	for (const [index, a] of lenses.entries())
		for (const b of lenses.slice(index + 1))
			if (templatesOverlap(a.template, b.template))
				throw new Error(`The templates '${a.name}' and '${b.name}' can match the same file`);
	return appOver(definitions, lenses);
}

/**
 * Several apps as one, as a shell opens a repository with every installed
 * app's collections. Each app was checked when it was defined. Two apps may
 * claim the same files: a collection is a view, not a permission
 * (ADR-0694), so a file shows in each collection that claims it. Two apps
 * may not use one name, which would be one property of the handle; that
 * throws.
 */
export function combineApps(apps: readonly App[]): App {
	const definitions: Definitions = {};
	for (const app of apps)
		for (const [name, definition] of Object.entries(app.definitions)) {
			if (name in definitions) throw new Error(`Two apps name a collection '${name}'`);
			definitions[name] = definition;
		}
	return appOver(definitions, apps.flatMap((app) => app.lenses));
}

function lensOf(name: string, definition: NoteDefinition | BlobDefinition): Lens {
	if (!IDENTIFIER.test(name) || name.startsWith('sqlite_'))
		throw new Error(`'${name}' is not an identifier usable as a name`);
	if (RESERVED.has(name))
		throw new Error(`'${name}' is reserved by the repository object`);
	const compiled = compileTemplate(definition.path);
	if (compiled.error !== null) throw new Error(compiled.error.message);
	const template = compiled.data;
	for (const param of template.params)
		if (VIEW_COLUMNS.has(param))
			throw new Error(`{${param}} in '${name}' collides with a view column`);
	if ('schema' in definition) {
		if (!templateEnds(template, '.md'))
			throw new Error(`The note template '${definition.path}' must end in .md`);
		const fields = schemaFields(definition.schema);
		for (const field of fields) {
			if (VIEW_COLUMNS.has(field) || template.params.includes(field))
				throw new Error(`The field '${field}' in '${name}' collides with a column`);
			if (field.includes('"'))
				throw new Error(`The field '${field}' in '${name}' cannot be a column`);
		}
		return {
			kind: 'note',
			name,
			template,
			schema: definition.schema,
			fields,
			view: viewSql(name, template, noteColumns(fields)),
			memory: definition.memory !== false,
		};
	}
	if (templateEnds(template, '.md'))
		throw new Error(`The blob template '${definition.path}' must not end in .md`);
	return { kind: 'blob', name, template, view: viewSql(name, template, BLOB_COLUMNS) };
}

function appOver<const TDefs extends Definitions>(definitions: TDefs, lenses: Lens[]) {
	return {
		definitions,
		lenses,
		/**
		 * Every collection that claims a path, with its parameters: one in a
		 * single app, possibly several in apps combined. A Markdown file is
		 * claimed only by note templates, so a broad blob template never
		 * claims a note.
		 */
		claims(path: string) {
			const note = isNote(path);
			return lenses.flatMap((lens) => {
				if ((lens.kind === 'note') !== note) return [];
				const params = matchTemplate(lens.template, path);
				return params === null ? [] : [{ lens, params }];
			});
		},
		/**
		 * `as` a note name, whether `text`'s fields match that name's schema
		 * (a text with no parseable frontmatter has none). Pure: it reads no repository, so an
		 * editor or a CLI can check a text before it is written.
		 */
		check(text: string, { as }: { as?: NoteName<TDefs> } = {}): TextStatus {
			const lens = as === undefined ? undefined : lenses.find((candidate) => candidate.name === as);
			if (lens?.kind !== 'note') return { matches: null };
			const issues = schemaIssues(lens.schema, parseMarkdown(text).fields);
			return issues.length === 0 ? { matches: true } : { matches: false, issues };
		},
	};
}
export type App<TDefs extends Definitions = Definitions> = ReturnType<typeof appOver<TDefs>>;

function schemaFields(schema: TSchema): string[] {
	const properties = (schema as { properties?: Record<string, unknown> }).properties;
	return properties === undefined ? [] : Object.keys(properties);
}

const quote = (name: string) => `"${name.replaceAll('"', '""')}"`;
const literal = (value: string) => `'${value.replaceAll("'", "''")}'`;

const BLOB_COLUMNS = [
	`json_extract(fields, '$.oid') AS "oid"`,
	`json_extract(fields, '$.size') AS "size"`,
];

function noteColumns(fields: string[]) {
	return [
		...fields.map((field) => `json_extract(fields, ${literal(`$."${field}"`)}) AS ${quote(field)}`),
		'body',
	];
}

/**
 * A read-only view over the files table. A path's segments are read as a JSON
 * array, which keeps every segment one linear expression; a path that is not
 * valid JSON once quoted (it holds a control character) matches no view.
 */
function viewSql(name: string, template: Template, columns: string[]) {
	const segment = (index: number) => `json_extract(segs, '$[${index}]')`;
	const where = [
		'json_valid(segs)',
		`json_array_length(segs) = ${template.segments.length}`,
	];
	const params: string[] = [];
	for (const [index, s] of template.segments.entries()) {
		const value = segment(index);
		if ('literal' in s) {
			where.push(`${value} = ${literal(s.literal)}`);
			continue;
		}
		const length = s.suffix.length;
		if (length > 0) where.push(`substr(${value}, -${length}) = ${literal(s.suffix)}`);
		where.push(`length(${value}) > ${length}`, `substr(${value}, 1, 1) <> '.'`);
		params.push(
			`${length > 0 ? `substr(${value}, 1, length(${value}) - ${length})` : value} AS ${quote(s.param)}`,
		);
	}
	const segs = `'["' || replace(replace(replace(path, '\\', '\\\\'), '"', '\\"'), '/', '","') || '"]'`;
	return `CREATE TEMP VIEW ${quote(name)} AS SELECT path, ${[...params, ...columns].join(', ')} FROM (SELECT path, fields, body, ${segs} AS segs FROM "epicenter/files" WHERE text IS NOT NULL) WHERE ${where.join(' AND ')}`;
}

/**
 * Checked against a note name, whether a text's fields match that name's
 * schema: a field the text lacks is an issue. `matches` is null when no
 * name was given.
 */
export type TextStatus = { matches: null } | { matches: true } | { matches: false; issues: string[] };

/** How `fields` fails `schema`, one line per issue; none when they match. */
export function schemaIssues(schema: TSchema, fields: Record<string, unknown>): string[] {
	if (Check(schema, fields)) return [];
	return Errors(schema, fields).map((error) => `${error.instancePath || '/'} ${error.message}`);
}

// ============================================================================
// Stem helpers: apps pass every segment; `slug` (core/door) and this make common stems.
// ============================================================================

/** A sortable UTC stem for a moment: `2026-10-28T12-00-00Z`. */
export function timestamp(at: Date = new Date()): string {
	return at.toISOString().replace(/\.\d{3}Z$/, 'Z').replaceAll(':', '-');
}
