/**
 * An app's lens over a repository, the pure half of `defineApp`. It maps
 * identifier names to path templates, each with a schema (a Markdown note)
 * or a blob declaration, refuses an app whose templates could claim one
 * file, derives per name the SQL view a device creates on open, and checks
 * a text against a name's schema (`app.check`) without a repository.
 */
import type { TSchema } from 'typebox';
import { Check, Errors } from 'typebox/value';
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
export type BlobDefinition = {
	path: string;
	blob: { types: readonly string[]; maxSize?: number };
};
export type Definitions = Record<string, NoteDefinition | BlobDefinition>;

/** The names of an app's note templates, as opposed to its blob templates. */
export type NoteName<TDefs extends Definitions> = {
	[K in keyof TDefs]: TDefs[K] extends { schema: TSchema } ? K : never;
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
const VIEW_COLUMNS = new Set(['path', 'body', 'oid', 'size', 'type']);

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
			blob: BlobDefinition['blob'];
			view: string;
	  };

/**
 * Define an app. Throws on a bad name, a bad template, a column collision or
 * two templates that could claim the same file: these are mistakes in the
 * app's source, found when it is loaded, not runtime conditions.
 */
export function defineApp<const TDefs extends Definitions>(definitions: TDefs) {
	const lenses: Lens[] = [];
	for (const [name, definition] of Object.entries(definitions)) {
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
			lenses.push({
				kind: 'note',
				name,
				template,
				schema: definition.schema,
				fields,
				view: viewSql(name, template, noteColumns(fields)),
				memory: definition.memory !== false,
			});
		} else {
			if (templateEnds(template, '.md'))
				throw new Error(`The blob template '${definition.path}' must not end in .md`);
			lenses.push({
				kind: 'blob',
				name,
				template,
				blob: definition.blob,
				view: viewSql(name, template, BLOB_COLUMNS),
			});
		}
	}
	for (const [index, a] of lenses.entries())
		for (const b of lenses.slice(index + 1))
			if (templatesOverlap(a.template, b.template))
				throw new Error(`The templates '${a.name}' and '${b.name}' can match the same file`);

	return {
		definitions,
		lenses,
		/**
		 * The lens a path belongs to, if any. A Markdown file belongs only to a
		 * note template, so a broad blob template never claims a note.
		 */
		classify(path: string) {
			const isNote = path.endsWith('.md');
			for (const lens of lenses) {
				if ((lens.kind === 'note') !== isNote) continue;
				const params = matchTemplate(lens.template, path);
				if (params !== null) return { lens, params };
			}
			return null;
		},
		/** The `.gitattributes` lines that route blob templates through LFS. */
		gitattributes() {
			return lenses
				.filter((lens) => lens.kind === 'blob')
				.map(
					(lens) =>
						`${lens.template.segments
							.map((s) => ('literal' in s ? s.literal : `*${s.suffix}`))
							.join('/')} filter=lfs diff=lfs merge=lfs -text`,
				)
				.join('\n');
		},
		/**
		 * Whether `text` parses and, `as` a note name, whether its fields
		 * match that name's schema. Pure: it reads no repository, so an
		 * editor or a CLI can check a text before it is written.
		 */
		check(text: string, { as }: { as?: NoteName<TDefs> } = {}): TextStatus {
			const parsed = parseMarkdown(text);
			if (parsed.error !== null) return { parses: false, line: parsed.error.line, message: parsed.error.reason };
			const lens = as === undefined ? undefined : lenses.find((candidate) => candidate.name === as);
			if (lens?.kind !== 'note') return { parses: true, matches: null };
			const issues = schemaIssues(lens.schema, parsed.data.fields);
			return issues.length === 0 ? { parses: true, matches: true } : { parses: true, matches: false, issues };
		},
	};
}
export type App<TDefs extends Definitions = Definitions> = ReturnType<
	typeof defineApp<TDefs>
>;

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
 * Whether a file's text parses, and, checked against a note name, whether
 * its fields match that name's schema. `line` counts from 1, the opening
 * `---`; `matches` is null when no name was given.
 */
export type TextStatus =
	| { parses: false; line: number; message: string }
	| { parses: true; matches: null }
	| { parses: true; matches: true }
	| { parses: true; matches: false; issues: string[] };

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
