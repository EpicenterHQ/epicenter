/**
 * A folder reads its tables through the declaration's own lenses, and every
 * acquisition entry exports one opener signature and one contract.
 */
import { expectTypeOf } from 'bun:test';
import { jsonValue } from '@epicenter/definition';
import type { InstantString } from '@epicenter/definition/field';
import type { Result } from 'wellcrafted/result';
import * as browser from './browser.js';
import * as bun from './bun.js';
import type * as contract from './contract.js';
import * as root from './index.js';
import {
	type CreateRowOf,
	defineFolder,
	defineTable,
	type FileContent,
	type FileError,
	type FileRead,
	type FileTable,
	type Folder,
	type FolderDefinition,
	type FolderGit,
	type FolderLocation,
	field,
	formatRow,
	type Issue,
	type Issues,
	type OpenDataFolder,
	type OpenDataFolderOptions,
	type OpenFolder,
	type OpenFolderError,
	type OpenFolderOptions,
	type PreparedFolderTable,
	parseRow,
	type Row,
	type RowReadError,
	type StoredRow,
	type TableListing,
	type WriteError,
	type Written,
	type WrittenRow,
} from './index.js';
import * as tauri from './tauri.js';

const definition = defineFolder({
	tables: {
		todos: defineTable({
			fields: {
				title: field.string(),
				due: field.nullable(field.instant()),
			},
		}),
	},
});
type Opened = Folder<typeof definition>;

// Nested values: a list, a branded instant, a tuple, and free-form JSON.
const nested = defineFolder({
	tables: {
		notes: defineTable({
			fields: {
				tags: field.tags(),
				at: field.instant(),
				meta: field.json(jsonValue),
			},
		}),
	},
});
type Note = CreateRowOf<typeof nested.tables.notes>;

// A refinement's type says it holds a callback, which a folder field cannot.
declare const refined: ReturnType<typeof field.string> & {
	readonly '~refine': readonly unknown[];
};
defineFolder({
	tables: {
		notes: defineTable({
			fields: {
				// @ts-expect-error A refinement is not JSON Schema.
				theme: refined,
			},
		}),
	},
});

// Only a table `defineFolder` prepared is read or formatted without a folder.
const rawTodos = defineTable({
	fields: {
		title: field.string(),
		due: field.nullable(field.instant()),
	},
});
// @ts-expect-error A raw declaration was never prepared.
parseRow(rawTodos, '---\ntitle: Milk\n---\n');
// @ts-expect-error Nor is it formatted.
formatRow(rawTodos, { fields: { title: 'Milk', due: null }, body: '' });
// An opener still takes a raw declaration and prepares it itself.
void root.openFolder({
	id: 'test.folder',
	definition: { tables: { todos: rawTodos } },
});
// Preparing changes no key or field type.
expectTypeOf(definition.tables.todos).toExtend<PreparedFolderTable>();
expectTypeOf<keyof typeof definition.tables.todos.fields>().toEqualTypeOf<
	'title' | 'due'
>();
expectTypeOf<CreateRowOf<typeof definition.tables.todos>>().toEqualTypeOf<
	CreateRowOf<typeof rawTodos>
>();
// A generic helper constrained to prepared tables keeps the exact table.
function readText<const TTable extends PreparedFolderTable>(
	table: TTable,
	text: string,
) {
	return parseRow(table, text);
}
expectTypeOf(readText(definition.tables.todos, '')).toEqualTypeOf<
	Result<Row<CreateRowOf<typeof definition.tables.todos>>, Issues>
>();
// @ts-expect-error It refuses a raw declaration as well.
readText(rawTodos, '');
// A spread that keeps the prepared field objects keeps the mark, and reads.
expectTypeOf(
	parseRow({ ...definition.tables.todos }, '').data,
).toEqualTypeOf<Row<CreateRowOf<typeof definition.tables.todos>> | null>();
// The mark is a type, not a proof: a spread with replaced fields still
// compiles, and reading a value through them throws (`definition.test.ts`).
parseRow({ ...definition.tables.todos, fields: rawTodos.fields }, '');

async function nestedValues(
	folder: Folder<typeof nested>,
	instant: InstantString,
) {
	const { notes } = folder.tables;
	const { data: stored, error: readError } = await notes.get('a');
	if (readError !== null || stored === undefined) return;
	// A stored row is valid, so every declared field is present.
	const { tags, at } = stored.row.fields;
	expectTypeOf(tags).toEqualTypeOf<string[]>();
	expectTypeOf(at).toEqualTypeOf<InstantString>();
	// The row is the caller's own to edit and save.
	stored.row.fields.tags.push('later');
	stored.row.fields.at = instant;
	stored.row.body = 'edited';
	// @ts-expect-error The capture never changes.
	stored.sha256 = 'changed';
	// @ts-expect-error Nor does the row it read.
	stored.row = { fields: stored.row.fields, body: '' };
	notes.write('a', stored.row, stored.row);
	notes.create({
		fields: { tags: ['a'], at: instant, meta: { a: [1] } },
		body: '',
	});
	// @ts-expect-error A row is complete: it names its body.
	notes.create({ fields: { tags: ['a'], at: instant, meta: null } });
	notes.write('a', stored.row, {
		...stored.row,
		// @ts-expect-error An unvalidated string still does not carry the brand.
		fields: { ...stored.row.fields, at: '2026-10-01T00:00:00.000Z' },
	});
	// Text read without a folder holds the same types.
	expectTypeOf(
		parseRow(nested.tables.notes, '').data,
	).toEqualTypeOf<Row<Note> | null>();
	expectTypeOf(stored.row).toEqualTypeOf<Row<Note>>();
}
void nestedValues;

// A tuple that ends in a rest keeps its positions: a required head, then any
// number of the rest. Written as a native schema, which is a field like any.
const headed = {
	type: 'array',
	items: [{ type: 'string' }],
	additionalItems: { type: 'number' },
	minItems: 1,
} as const;
const tuples = defineFolder({
	tables: { rows: defineTable({ fields: { span: headed } }) },
});
type Span = CreateRowOf<typeof tuples.tables.rows>['span'];
expectTypeOf<Span>().toEqualTypeOf<[string, ...number[]]>();

async function tupleValues(folder: Folder<typeof tuples>) {
	const { rows } = folder.tables;
	const { data: stored, error: readError } = await rows.get('a');
	if (readError !== null || stored === undefined) return;
	const { span } = stored.row.fields;
	expectTypeOf(span).toEqualTypeOf<[string, ...number[]]>();
	expectTypeOf(span[0]).toEqualTypeOf<string>();
	expectTypeOf(span[1]).toEqualTypeOf<number | undefined>();

	// What was read goes back in, and input keeps the head it requires.
	rows.write('a', stored.row, { fields: { span }, body: '' });
	rows.set('a', { span: ['a', 1, 2] });
	rows.create({ fields: { span: ['a'] }, body: '' });
	// @ts-expect-error The head is a string.
	rows.set('a', { span: [1, 'a'] });
	// @ts-expect-error The head is required.
	rows.set('a', { span: [] });
	// @ts-expect-error The rest are numbers.
	rows.create({ fields: { span: ['a', 'b'] }, body: '' });
}
void tupleValues;

expectTypeOf<Opened['tables']['todos']>().toEqualTypeOf<
	FileTable<CreateRowOf<typeof definition.tables.todos>>
>();
// Settings are a table, `settings`; a folder has no handle of their own.
// @ts-expect-error There is no `kv`.
export type _NoKv = Opened['kv'];
// Every handle exposes the definition it reads with.
expectTypeOf<Opened['definition']>().toEqualTypeOf<typeof definition>();
expectTypeOf<
	CreateRowOf<typeof definition.tables.todos>['due']
>().toEqualTypeOf<InstantString | null>();

// One opener signature at every entry, with one Git surface.
expectTypeOf(root.openFolder).toEqualTypeOf<OpenFolder>();
expectTypeOf(browser.openFolder).toEqualTypeOf<OpenFolder>();
expectTypeOf(tauri.openFolder).toEqualTypeOf<OpenFolder>();
expectTypeOf<keyof Opened['git']>().toEqualTypeOf<keyof FolderGit>();
expectTypeOf(root.openFolder<typeof definition>).returns.toEqualTypeOf<
	Promise<Result<Opened, OpenFolderError>>
>();
expectTypeOf(root.openFolder<typeof definition>)
	.parameter(0)
	.toEqualTypeOf<OpenFolderOptions<typeof definition>>();
// The opener names the folder; the definition does not.
expectTypeOf<
	OpenFolderOptions<typeof definition>['id']
>().toEqualTypeOf<string>();
// @ts-expect-error A folder is opened by its ID.
void root.openFolder({ definition });

// One data-folder opener signature at the automatic entry and at both
// explicit entries: an existing folder by ID, with its own schema.
expectTypeOf(root.openDataFolder).toEqualTypeOf<OpenDataFolder>();
expectTypeOf(browser.openDataFolder).toEqualTypeOf<OpenDataFolder>();
expectTypeOf(tauri.openDataFolder).toEqualTypeOf<OpenDataFolder>();
expectTypeOf<keyof OpenDataFolderOptions>().toEqualTypeOf<
	'id' | 'credentials' | 'browser' | 'lens'
>();
expectTypeOf(root.openDataFolder).returns.toEqualTypeOf<
	Promise<Result<Folder<FolderDefinition>, OpenFolderError>>
>();
async function untypedRows(folder: Folder<FolderDefinition>) {
	// A data folder's tables are whatever its epicenter.json declares.
	const table = folder.tables.anything;
	expectTypeOf(folder.definition).toEqualTypeOf<FolderDefinition>();
	void table;
}
void untypedRows;

// A lens types the tables it reads; `definition` stays the folder's own
// declaration, and a table may refuse to add rows.
const board = defineFolder({
	tables: {
		todos: defineTable({
			fields: { title: field.string(), status: field.select(['todo', 'done']) },
		}),
	},
});
type Lensed = Folder<typeof board, FolderDefinition>;
expectTypeOf(root.openDataFolder<typeof board>).returns.toEqualTypeOf<
	Promise<Result<Lensed, OpenFolderError>>
>();
expectTypeOf(browser.openDataFolder<typeof board>).returns.toEqualTypeOf<
	Promise<Result<Lensed, OpenFolderError>>
>();
expectTypeOf(bun.openDataFolder<typeof board>).returns.toEqualTypeOf<
	Promise<Result<Lensed, OpenFolderError>>
>();
async function lensedRows() {
	const { data: folder, error } = await root.openDataFolder({
		id: 'so.epicenter.todos',
		lens: board,
	});
	if (error !== null) {
		if (error.name === 'ShapeMismatch')
			expectTypeOf(error.problems[0]!.kind).toEqualTypeOf<
				| 'missingTable'
				| 'incompatibleTable'
				| 'missingField'
				| 'incompatibleField'
			>();
		return;
	}
	expectTypeOf(folder).toEqualTypeOf<Lensed>();
	expectTypeOf(folder.definition).toEqualTypeOf<FolderDefinition>();
	expectTypeOf(folder.tables.todos.canCreate).toEqualTypeOf<boolean>();
	// @ts-expect-error The lens declares no such table.
	void folder.tables.projects;
	const created = await folder.tables.todos.create({
		fields: { title: 'Milk', status: 'todo' },
		body: '',
	});
	// A lens that cannot supply a field the folder requires adds nothing.
	if (created.error?.name === 'InvalidValues')
		expectTypeOf(created.error.issues).toEqualTypeOf<readonly Issue[]>();
	folder.tables.todos.create({
		// @ts-expect-error A lens field keeps its declared type.
		fields: { title: 'Milk', status: 'blocked' },
		body: '',
	});
}
void lensedRows;

// Every entry exports the same contract, so a build may resolve one for another.
type Contract = typeof contract;
type EntryPoint<T> = Omit<T, 'openFolder' | 'openDataFolder'>;
expectTypeOf<EntryPoint<typeof root>>().toEqualTypeOf<Contract>();
// A browser folder takes an author, a transport, and test storage; its
// remote is its Git configuration, which `sync.connect` sets.
expectTypeOf<keyof contract.BrowserFolderOptions>().toEqualTypeOf<
	'author' | 'httpFetch' | 'opfs'
>();

// The browser entry is the contract and its opener, and nothing else.
expectTypeOf<EntryPoint<typeof browser>>().toEqualTypeOf<Contract>();
// The desktop entry adds only the opener of the folder the shell handed a window.
expectTypeOf<
	Omit<EntryPoint<typeof tauri>, 'openHandedFolder'>
>().toEqualTypeOf<Contract>();
expectTypeOf<Pick<typeof bun, keyof Contract>>().toEqualTypeOf<Contract>();

// The directory openers are their own contract: an explicit root and history.
expectTypeOf(bun.openDataFolder<FolderDefinition>)
	.parameter(0)
	.toEqualTypeOf<bun.DataFolderOptions>();
expectTypeOf(bun.openDataFolder<FolderDefinition>).returns.toEqualTypeOf<
	Promise<Result<Folder<FolderDefinition, FolderDefinition>, OpenFolderError>>
>();
expectTypeOf(bun.openFolder<typeof definition>)
	.parameter(0)
	.toEqualTypeOf<bun.DirectoryFolderOptions<typeof definition>>();
expectTypeOf(bun.openFolder<typeof definition>).returns.toEqualTypeOf<
	Promise<Result<Folder<typeof definition, typeof definition>, OpenFolderError>>
>();

async function typedValues(folder: Opened, instant: InstantString) {
	folder.tables.todos.create({
		fields: { title: 'Milk', due: null },
		body: '',
	});
	folder.tables.todos.create({
		fields: { title: 'Milk', due: instant },
		body: '',
	});
	folder.tables.todos.create({
		// @ts-expect-error An unvalidated string does not carry the instant brand.
		fields: { title: 'Milk', due: '2026-10-01T00:00:00.000Z' },
		body: '',
	});
	// @ts-expect-error Typed fields retain validation.
	folder.tables.todos.create({ fields: { title: 12, due: null }, body: '' });
	// @ts-expect-error Creating a row supplies every declared field.
	folder.tables.todos.create({ fields: { title: 'Milk' }, body: '' });
	folder.tables.todos.create({
		fields: { title: 'Milk', due: null },
		body: '',
		// @ts-expect-error A row carries no attachment.
		attachment: {},
	});
	// @ts-expect-error Only declared tables exist.
	folder.tables.lists;

	// A read is the file's detached bytes and the SHA-256 that names them.
	const { data: file, error: readError } = await folder.files.read('a.md');
	if (readError !== null) return;
	expectTypeOf(file).toEqualTypeOf<FileRead>();
	// A file's content changes through the one write, from the content it
	// started from, and a file moves through the one move; each answers the
	// file as it left it, and fails as one `WriteError`.
	const { data: saved, error: writeFileError } = await folder.write(
		'a.md',
		file.bytes,
		'next',
	);
	if (writeFileError !== null) {
		expectTypeOf(writeFileError).toEqualTypeOf<WriteError>();
		return;
	}
	expectTypeOf(saved).toEqualTypeOf<Written>();
	expectTypeOf(saved.file).toEqualTypeOf<FileRead | null>();
	expectTypeOf(folder.write).parameter(1).toEqualTypeOf<FileContent | null>();
	expectTypeOf(await folder.move('a.md', 'b.md')).toEqualTypeOf<
		Result<Written, WriteError>
	>();
	// A stored row is its row file's path, hash, and text, with the row it holds.
	const entry = await folder.tables.todos.get('milk');
	type Fields = CreateRowOf<typeof definition.tables.todos>;
	if (entry.error === null) {
		expectTypeOf(entry.data).toEqualTypeOf<StoredRow<Fields> | undefined>();
	} else expectTypeOf(entry.error).toEqualTypeOf<RowReadError>();
	if (entry.data) {
		expectTypeOf<keyof StoredRow<Fields>>().toEqualTypeOf<
			'path' | 'sha256' | 'text' | 'row'
		>();
		// A valid row is complete: every declared field, and the body.
		expectTypeOf(entry.data.row.fields).toEqualTypeOf<{
			title: string;
			due: InstantString | null;
		}>();
		expectTypeOf(entry.data.row.body).toEqualTypeOf<string>();
		// @ts-expect-error A stored row keeps its path.
		entry.data.path = '';
		// @ts-expect-error A valid row carries no diagnostics.
		entry.data.issues;
	}
	// Text that is not a valid row is an error that keeps the text and its hash.
	if (entry.error?.name === 'InvalidRow') {
		expectTypeOf(entry.error.sha256).toEqualTypeOf<string>();
		expectTypeOf(entry.error.text).toEqualTypeOf<string>();
		expectTypeOf(entry.error.issues).toEqualTypeOf<Issues>();
		expectTypeOf<keyof Issue>().toEqualTypeOf<'message' | 'line' | 'field'>();
		// @ts-expect-error Issues cannot be changed in place.
		entry.error.issues.push({ message: '' });
		// A repair is a write of its text, or a delete.
		folder.write(entry.error.path, entry.error.text, '---\n---\n');
		folder.tables.todos.delete('milk');
	}
	// One synchronous reader and one writer for saved text and for drafts, on
	// the definition rather than an open table.
	expectTypeOf(parseRow(definition.tables.todos, '---\n---\n')).toEqualTypeOf<
		Result<Row<Fields>, Issues>
	>();
	expectTypeOf(
		formatRow(definition.tables.todos, {
			fields: { title: 'Milk', due: null },
			body: 'b',
		}),
	).toEqualTypeOf<Result<string, Issue>>();
	// @ts-expect-error Formatting names only declared fields.
	formatRow(definition.tables.todos, { fields: { titel: 'Milk' }, body: '' });
	// @ts-expect-error Formatting takes a definition's table, not an open one.
	formatRow(folder.tables.todos, {
		fields: { title: 'Milk', due: null },
		body: '',
	});
	// @ts-expect-error Interpretation is not a method of an open table.
	folder.tables.todos.inspect;
	// A listing is one array of per-file Results under one enumeration Result.
	const listing = await folder.tables.todos.list();
	expectTypeOf(listing).toEqualTypeOf<
		Result<TableListing<Fields>, FileError>
	>();
	if (listing.error === null) {
		expectTypeOf(listing.data[0]!.stem).toEqualTypeOf<string>();
		expectTypeOf(listing.data[0]!.result).toEqualTypeOf<
			Result<StoredRow<Fields>, RowReadError>
		>();
		// @ts-expect-error There is no separate list of unreadable files.
		listing.data.unreadable;
	}
	const { error: createError } = await folder.tables.todos.create({
		fields: { title: 'Milk', due: null },
		body: '',
	});
	if (createError !== null) {
		expectTypeOf(createError).toEqualTypeOf<WriteError>();
		// @ts-expect-error A create at an occupied stem merges; nothing refuses it.
		createError.name === 'Exists';
		if (createError.name === 'InvalidValues')
			expectTypeOf(createError.issues).toEqualTypeOf<readonly Issue[]>();
		// @ts-expect-error A table has no naming rule of its own.
		createError.name === 'InvalidStem';
		// @ts-expect-error Nor a collision rule.
		createError.name === 'Collision';
		// @ts-expect-error Text is decoded only by reads.
		createError.name === 'InvalidUtf8';
	}
	// A set sets declared fields of the row as it is now, each to its declared type.
	void folder.tables.todos.set('milk', { title: 'Milk' });
	// @ts-expect-error A field holds its declared type.
	void folder.tables.todos.set('milk', { title: 1 });
	// A delete names only the stem: the deleter wins.
	folder.tables.todos.delete('milk');
	// @ts-expect-error There is no guard to pass.
	folder.tables.todos.delete('milk', { expectedSha256: 'a'.repeat(64) });
	if (entry.data) {
		// A write names the row the change started from and the row it ends at.
		const { data: written, error: writeError } =
			await folder.tables.todos.write('milk', entry.data.row, entry.data.row);
		if (writeError === null)
			expectTypeOf(written).toEqualTypeOf<WrittenRow<Fields>>();
		else {
			expectTypeOf(writeError).toEqualTypeOf<WriteError>();
			// @ts-expect-error A write fails in five ways, and this is none.
			writeError.name === 'Conflict';
		}
		// @ts-expect-error A table writes a row; complete text is the folder's write.
		folder.tables.todos.write('milk', entry.data.row, '---\n---\n');
		folder.write(entry.data.path, entry.data.text, '---\n---\n');
		expectTypeOf(
			await folder.tables.todos.rename('milk', 'next'),
		).toEqualTypeOf<Result<WrittenRow<Fields>, WriteError>>();
		expectTypeOf(await folder.tables.todos.delete('milk')).toEqualTypeOf<
			Result<undefined, WriteError>
		>();
	}
	// @ts-expect-error The file verbs are gone: every change is the one write.
	folder.files.save;
	// @ts-expect-error A delete is a write to no file, never `remove`.
	folder.files.remove;
	// @ts-expect-error A file moves through the one move.
	folder.files.move;
	// @ts-expect-error A create is a write from no file.
	folder.files.create;
	// @ts-expect-error There is no unguarded write.
	folder.files.overwrite('a.md', 'next');
	// @ts-expect-error Several changes are several calls; there is no batch.
	folder.batch;

	expectTypeOf(folder.location).toEqualTypeOf<FolderLocation>();
	expectTypeOf(folder.onFilesChanged(() => {})).toEqualTypeOf<() => void>();
	// A change names its paths, or everything when the reporter cannot say.
	expectTypeOf(folder.onFilesChanged)
		.parameter(0)
		.parameter(0)
		.toEqualTypeOf<readonly string[] | 'everything'>();
}
void typedValues;

// A table declares fields, not a body conversion: a row's body is the file's Markdown text.
defineFolder({
	tables: {
		notes: defineTable({
			fields: { title: field.string() },
			// @ts-expect-error A table has no body option.
			body: { encode: () => '', decode: () => undefined },
		}),
	},
});
defineFolder({
	// @ts-expect-error A folder definition names no folder; the opener does.
	id: 'test.named',
	tables: {},
});
defineFolder({
	tables: {
		// @ts-expect-error A table is authored with `defineTable`.
		notes: { fields: { title: field.string() } },
	},
});

// The settings table's fields may all be unset; a required one is refused.
defineFolder({
	tables: {
		settings: defineTable({
			fields: {
				theme: field.optional(field.select(['light', 'dark'])),
				width: field.optional(field.integer()),
			},
		}),
	},
});
defineFolder({
	tables: {
		// @ts-expect-error A setting may be unset, so it is field.optional.
		settings: defineTable({
			fields: {
				theme: field.string(),
				width: field.optional(field.integer()),
			},
		}),
		// The same fields in another table stay required.
		display: defineTable({ fields: { theme: field.string() } }),
	},
});

// A set takes any declared fields, each at its declared type.
type Errand = { title: string; note?: string; due?: string | null };
expectTypeOf<{ due: null; note: 'x' }>().toExtend<Partial<Errand>>();
expectTypeOf<{ title: 1 }>().not.toExtend<Partial<Errand>>();
