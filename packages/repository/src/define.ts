/**
 * `defineApp`: an app's lens over a repository. It maps identifier names to
 * path templates, each with a schema (a Markdown note) or a blob declaration,
 * refuses an app whose templates could claim one file, and derives per name
 * the SQL view a device creates on open and the handle type apps call.
 */
import type { Static, TSchema } from 'typebox';
import { defineErrors, type InferErrors } from 'wellcrafted/error';
import type { Result } from 'wellcrafted/result';
import type { ChangeOutcome } from './protocol.js';
import {
	compileTemplate,
	IDENTIFIER,
	matchTemplate,
	type Params,
	type ParamsArg,
	type Template,
	templateEnds,
	templatesOverlap,
} from './templates.js';

export type NoteDefinition = { path: string; schema: TSchema };
export type BlobDefinition = {
	path: string;
	blob: { types: readonly string[]; maxSize?: number };
};
export type Definitions = Record<string, NoteDefinition | BlobDefinition>;

/** Names the repository object itself uses, so no handle can shadow them. */
const RESERVED = new Set([
	'batch',
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

// ============================================================================
// Handle types
// ============================================================================

export const WriteError = defineErrors({
	/** A parameter value cannot be a path segment. */
	InvalidParams: ({ handle, reason }: { handle: string; reason: string }) => ({
		message: `Invalid parameters for '${handle}': ${reason}`,
		handle,
		reason,
	}),
	/** `create` found a file already there. */
	Exists: ({ path }: { path: string }) => ({
		message: `A file already exists at '${path}'`,
		path,
	}),
	/** The change needs a file that is not there. */
	NotFound: ({ path }: { path: string }) => ({
		message: `There is no file at '${path}'`,
		path,
	}),
	/** The file's frontmatter does not parse, so its fields cannot change. */
	Unparseable: ({ path, reason }: { path: string; reason: string }) => ({
		message: `The frontmatter of '${path}' does not parse: ${reason}`,
		path,
		reason,
	}),
	/** A blob is not one of its template's declared types or is too large. */
	BlobRefused: ({ path, reason }: { path: string; reason: string }) => ({
		message: `The blob for '${path}' was refused: ${reason}`,
		path,
		reason,
	}),
	/** The blob store did not take the bytes, so no pointer was written. */
	BlobUploadFailed: ({ path, cause }: { path: string; cause: unknown }) => ({
		message: `The blob for '${path}' could not be stored`,
		path,
		cause,
	}),
	/** The repository was closed before the change settled. */
	Closed: () => ({ message: 'The repository is closed' }),
});
export type WriteError = InferErrors<typeof WriteError>;

/** How the server settled one change. */
export type Settled =
	/** `seq` and `change` are null for a retry of a batch whose receipt left with its commit. */
	| { kind: 'applied'; seq: number | null; change: ChangeOutcome | null }
	| { kind: 'refused'; path: string; reason: string };

/**
 * A write's outcome. It is applied on this device before the call returns, so
 * reads see it at once; the Promise settles when the server answers, which
 * may be much later for a device offline, or never without a server.
 */
export type Pending<T = Settled> = Promise<Result<T, WriteError>>;

/**
 * A query that re-runs after any change on this device. `subscribe` calls
 * back with the first result and then only when the result differs; it
 * returns the function that stops it.
 */
export type Live<T> = { subscribe(onChange: (value: T) => void): () => void };

export type NoteInput<TSchema extends TSchema_> = {
	fields?: Partial<Static<TSchema>>;
	body?: string;
};
type TSchema_ = TSchema;

/** A note as read. Fields that fail the schema are returned raw, with issues. */
export type Note<TPath extends string, TSchema extends TSchema_> = {
	path: string;
	params: Params<TPath>;
	text: string;
	body: string;
} & (
	| { valid: true; fields: Static<TSchema> }
	| { valid: false; fields: Record<string, unknown>; issues: string[] }
);

/**
 * One note held open for editing. `read` answers synchronously and is
 * current: a write through the handle shows at once, and changes from
 * elsewhere arrive through `subscribe`.
 */
export type OpenNote<TPath extends string, TSchema extends TSchema_> = {
	params: Params<TPath>;
	/** The note as this device shows it, or null when there is none. */
	read(): Note<TPath, TSchema> | null;
	/** Call back whenever `read` would answer differently. */
	subscribe(onChange: (note: Note<TPath, TSchema> | null) => void): () => void;
	/** Change some fields and or the body; creates the note when it is absent. */
	write(input: NoteInput<TSchema>): Pending;
	set<TKey extends keyof Static<TSchema> & string>(key: TKey, value: Static<TSchema>[TKey]): Pending;
	append(text: string): Pending;
	delete(): Pending;
	/** Stop following changes. */
	close(): void;
};

export type NoteHandle<TPath extends string, TSchema extends TSchema_> = {
	get(...params: ParamsArg<TPath>): Promise<Note<TPath, TSchema> | null>;
	list(filter?: Partial<Params<TPath>>): Promise<Note<TPath, TSchema>[]>;
	/** `list`, re-run after every change. */
	live(filter?: Partial<Params<TPath>>): Live<Note<TPath, TSchema>[]>;
	/** Hold one note open: reads are synchronous and follow every change. */
	open(...params: ParamsArg<TPath>): Promise<OpenNote<TPath, TSchema>>;
	/** Refused locally when the file exists on this device. */
	create(...args: [...ParamsArg<TPath>, NoteInput<TSchema>]): Pending;
	/** Change some fields and or the body; creates the note when it is absent. */
	write(...args: [...ParamsArg<TPath>, NoteInput<TSchema>]): Pending;
	/** Set one frontmatter field. */
	set<TKey extends keyof Static<TSchema> & string>(
		...args: [...ParamsArg<TPath>, key: TKey, value: Static<TSchema>[TKey]]
	): Pending;
	/** Append text to the end; needs no base, so concurrent appends both land. */
	append(...args: [...ParamsArg<TPath>, text: string]): Pending;
	move(from: Params<TPath>, to: Params<TPath>): Pending;
	delete(...params: ParamsArg<TPath>): Pending;
};

export type BlobEntry<TPath extends string> = {
	path: string;
	params: Params<TPath>;
	oid: string;
	size: number;
};

export type BlobHandle<TPath extends string> = {
	/** Store the bytes, then write the pointer: a pointer never names missing bytes. */
	put(...args: [...ParamsArg<TPath>, bytes: Uint8Array, options: { type: string }]): Pending;
	get(...params: ParamsArg<TPath>): Promise<Uint8Array | null>;
	url(...params: ParamsArg<TPath>): Promise<string | null>;
	list(filter?: Partial<Params<TPath>>): Promise<BlobEntry<TPath>[]>;
	live(filter?: Partial<Params<TPath>>): Live<BlobEntry<TPath>[]>;
	delete(...params: ParamsArg<TPath>): Pending;
};

/** Write-only note handles inside `repo.batch`: nothing to read, nothing to await. */
export type BatchNoteHandle<TPath extends string, TSchema extends TSchema_> = {
	create(...args: [...ParamsArg<TPath>, NoteInput<TSchema>]): void;
	write(...args: [...ParamsArg<TPath>, NoteInput<TSchema>]): void;
	set<TKey extends keyof Static<TSchema> & string>(
		...args: [...ParamsArg<TPath>, key: TKey, value: Static<TSchema>[TKey]]
	): void;
	append(...args: [...ParamsArg<TPath>, text: string]): void;
	move(from: Params<TPath>, to: Params<TPath>): void;
	delete(...params: ParamsArg<TPath>): void;
};

export type BatchBlobHandle<TPath extends string> = {
	put(...args: [...ParamsArg<TPath>, bytes: Uint8Array, options: { type: string }]): void;
	delete(...params: ParamsArg<TPath>): void;
};

export type Handles<TDefs extends Definitions> = {
	[K in keyof TDefs]: TDefs[K] extends { path: infer TPath extends string; schema: infer TSchema extends TSchema_ }
		? NoteHandle<TPath, TSchema>
		: TDefs[K] extends { path: infer TPath extends string }
			? BlobHandle<TPath>
			: never;
};

export type BatchHandles<TDefs extends Definitions> = {
	[K in keyof TDefs]: TDefs[K] extends { path: infer TPath extends string; schema: infer TSchema extends TSchema_ }
		? BatchNoteHandle<TPath, TSchema>
		: TDefs[K] extends { path: infer TPath extends string }
			? BatchBlobHandle<TPath>
			: never;
};

// ============================================================================
// Stem helpers: apps pass every segment; these make common stems.
// ============================================================================

/** A lowercase, dash-separated stem from a title: `slug('Fix login!')` is `fix-login`. */
export function slug(title: string): string {
	const stem = title
		.normalize('NFKD')
		.replace(/[̀-ͯ]/g, '')
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, '-')
		.replace(/^-+|-+$/g, '');
	return stem === '' ? 'untitled' : stem;
}

/** A sortable UTC stem for a moment: `2026-10-28T12-00-00Z`. */
export function timestamp(at: Date = new Date()): string {
	return at.toISOString().replace(/\.\d{3}Z$/, 'Z').replaceAll(':', '-');
}
