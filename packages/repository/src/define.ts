/**
 * `defineApp`: an app's lens over a repository. It maps identifier names to
 * path templates, each with a schema (a Markdown note) or a blob declaration,
 * refuses an app whose templates could claim one file, and derives per name
 * the SQL view a device creates on open and the handle type apps call.
 */
import type { Static, TSchema } from 'typebox';
import { defineErrors, type InferErrors } from 'wellcrafted/error';
import type { Result } from 'wellcrafted/result';
import type { ChangeOutcome, Overlap } from './protocol.js';
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
	'send',
	'notices',
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
	/** The text cannot be stored: binary text outside Git LFS, or a note over 1 MB. */
	NotStorable: ({ path, reason }: { path: string; reason: string }) => ({
		message: `'${path}' cannot be stored: ${reason}`,
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

export const SendError = defineErrors({
	/** The server is not reachable. Nothing was queued, so the caller may do the change another way. */
	Offline: () => ({ message: 'The server is not reachable; nothing was sent' }),
	/**
	 * The batch may have reached the server, but its verdict did not arrive
	 * here. Its numbered row stays, and the device sends it again when it can;
	 * the server answers that retry from its receipt, so it never lands twice.
	 */
	Unknown: ({ n }: { n: number }) => ({
		message: `Batch ${n} may have reached the server; its verdict will be known when it is sent again`,
		n,
	}),
	/** The version a change names as its base is not one this device holds. */
	UnknownBase: ({ path, base }: { path: string; base: string }) => ({
		message: `The version ${base} of '${path}' is not on this device; read it again`,
		path,
		base,
	}),
});
export type SendError = InferErrors<typeof SendError>;

/** The server's verdict on a `send`: an expected answer, so it is data, not an error. */
export type Verdict =
	/** `seq` is null and `changes` empty for a retry whose receipt left with its commit. */
	| { kind: 'applied'; seq: number | null; changes: ChangeOutcome[] }
	| { kind: 'refused'; path: string; reason: string; overlaps: Overlap[] };

/**
 * A person's write: it resolves once the change is saved in this device's
 * database, and reads see it from then on. It never waits for the server.
 * What the server later does with it, when that is something the person
 * should know, becomes a `Notice`.
 */
export type Saved = Promise<Result<undefined, WriteError>>;

/**
 * Something that happened to a person's change after it was saved, kept on
 * this device until the person dismisses it. Notices never sync.
 *
 * - `refused`: the change, or a value in it, was not applied: a field
 *   another device changed meanwhile (the current value wins), a rename of a
 *   note renamed elsewhere, or onto a name another note holds (the current
 *   name wins and the note stays where the server has it), or a `send`
 *   refused after its caller stopped waiting.
 * - `dropped`: the change had nothing left to apply to, such as a move of a
 *   note deleted elsewhere.
 * - `relocated`: the note's path was deleted and reused by another note, so
 *   the change was saved in a copy at `path`.
 * - `protocol`: the server could not apply the change, which is a bug. The
 *   device shows the server's text again, and `kept` holds what it showed.
 */
export type Notice = {
	id: number;
	/** When this device learned of it, in milliseconds since the epoch. */
	at: number;
	kind: 'refused' | 'dropped' | 'relocated' | 'protocol';
	/** Where the person should look. */
	path: string;
	reason: string;
	/** The text this device showed when the change was taken back, so nothing typed is lost. */
	kept: string | null;
};

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
	/**
	 * The server's version of this text (its Git blob hash), or null while
	 * this device holds changes to it the server has not acknowledged. A
	 * `send` names it as its base so that it is refused if the note changed
	 * since it was read.
	 */
	version: string | null;
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
	write(input: NoteInput<TSchema>): Saved;
	/**
	 * Replace the body with `body`, an edit of the body this handle last
	 * showed. A change that reached this device meanwhile, but that the
	 * handle had not shown yet, is kept: the edit is merged onto it. An
	 * editor writes each change this way, so text typed while a change from
	 * elsewhere was arriving never takes that change back.
	 */
	edit(body: string): Saved;
	set<TKey extends keyof Static<TSchema> & string>(key: TKey, value: Static<TSchema>[TKey]): Saved;
	append(text: string): Saved;
	delete(): Saved;
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
	create(...args: [...ParamsArg<TPath>, NoteInput<TSchema>]): Saved;
	/** Change some fields and or the body; creates the note when it is absent. */
	write(...args: [...ParamsArg<TPath>, NoteInput<TSchema>]): Saved;
	/** Set one frontmatter field. */
	set<TKey extends keyof Static<TSchema> & string>(
		...args: [...ParamsArg<TPath>, key: TKey, value: Static<TSchema>[TKey]]
	): Saved;
	/** Append text to the end; needs no base, so concurrent appends both land. */
	append(...args: [...ParamsArg<TPath>, text: string]): Saved;
	move(from: Params<TPath>, to: Params<TPath>): Saved;
	delete(...params: ParamsArg<TPath>): Saved;
};

export type BlobEntry<TPath extends string> = {
	path: string;
	params: Params<TPath>;
	oid: string;
	size: number;
};

export type BlobHandle<TPath extends string> = {
	/** Store the bytes, then write the pointer: a pointer never names missing bytes. */
	put(...args: [...ParamsArg<TPath>, bytes: Uint8Array, options: { type: string }]): Saved;
	get(...params: ParamsArg<TPath>): Promise<Uint8Array | null>;
	url(...params: ParamsArg<TPath>): Promise<string | null>;
	list(filter?: Partial<Params<TPath>>): Promise<BlobEntry<TPath>[]>;
	live(filter?: Partial<Params<TPath>>): Live<BlobEntry<TPath>[]>;
	delete(...params: ParamsArg<TPath>): Saved;
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

/**
 * What a `send` change starts from: the `version` of the note the caller
 * read. Without one (or with null), it starts from the text the server last
 * acknowledged.
 */
export type SendOptions = { base?: string | null };

/** Write-only note handles inside `repo.send`; each change may name the version it starts from. */
export type SendNoteHandle<TPath extends string, TSchema extends TSchema_> = {
	create(...args: [...ParamsArg<TPath>, NoteInput<TSchema>]): void;
	write(...args: [...ParamsArg<TPath>, NoteInput<TSchema>, options?: SendOptions]): void;
	set<TKey extends keyof Static<TSchema> & string>(
		...args: [...ParamsArg<TPath>, key: TKey, value: Static<TSchema>[TKey], options?: SendOptions]
	): void;
	append(...args: [...ParamsArg<TPath>, text: string, options?: SendOptions]): void;
	move(from: Params<TPath>, to: Params<TPath>): void;
	delete(...args: [...ParamsArg<TPath>, options?: SendOptions]): void;
};

export type SendBlobHandle<TPath extends string> = {
	put(...args: [...ParamsArg<TPath>, bytes: Uint8Array, options: { type: string } & SendOptions]): void;
	delete(...args: [...ParamsArg<TPath>, options?: SendOptions]): void;
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

export type SendHandles<TDefs extends Definitions> = {
	[K in keyof TDefs]: TDefs[K] extends { path: infer TPath extends string; schema: infer TSchema extends TSchema_ }
		? SendNoteHandle<TPath, TSchema>
		: TDefs[K] extends { path: infer TPath extends string }
			? SendBlobHandle<TPath>
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
