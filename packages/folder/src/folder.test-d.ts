/**
 * A folder reads its tables and KV through the declaration's own lenses, and
 * every acquisition entry exports one opener signature and one contract.
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
	type CapturedFile,
	type CreateRowOf,
	defineFolder,
	defineTable,
	type FileCapture,
	type FileError,
	type FileKv,
	type FileTable,
	type Folder,
	type FolderDefinition,
	type FolderLocation,
	field,
	formatRow,
	type Issue,
	type Issues,
	type KvOf,
	type KvReadError,
	type KvReading,
	type KvWriteError,
	type MoveError,
	type OpenDataFolder,
	type OpenDataFolderOptions,
	type OpenFolder,
	type OpenFolderError,
	type OpenFolderOptions,
	type PreparedFolderTable,
	parseRow,
	type Replaced,
	type Row,
	type RowReadError,
	type StoredRow,
	type TableCreateError,
	type TableDeleteError,
	type TableEnumerationError,
	type TableListing,
	type TableRenameError,
	type TableSaveError,
} from './index.js';
import * as tauri from './tauri.js';

const definition = defineFolder({
	kv: { theme: field.string() },
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
	kv: {
		recent: field.tags(),
		since: field.instant(),
		layout: field.json(jsonValue),
	},
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

// A refinement's type says it holds a callback, which a folder setting cannot.
declare const refined: ReturnType<typeof field.string> & {
	readonly '~refine': readonly unknown[];
};
defineFolder({
	// @ts-expect-error A refinement is not JSON Schema.
	kv: { theme: refined },
	tables: {},
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
	definition: { kv: {}, tables: { todos: rawTodos } },
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
	notes.save(stored, stored.row);
	notes.create({
		fields: { tags: ['a'], at: instant, meta: { a: [1] } },
		body: '',
	});
	// @ts-expect-error A row is complete: it names its body.
	notes.create({ fields: { tags: ['a'], at: instant, meta: null } });
	notes.save(stored, {
		...stored.row,
		// @ts-expect-error An unvalidated string still does not carry the brand.
		fields: { ...stored.row.fields, at: '2026-10-01T00:00:00.000Z' },
	});
	// Text read without a folder holds the same types.
	expectTypeOf(
		parseRow(nested.tables.notes, '').data,
	).toEqualTypeOf<Row<Note> | null>();
	expectTypeOf(stored.row).toEqualTypeOf<Row<Note>>();

	const { data: kv, error: kvError } = await folder.kv.get();
	if (kvError !== null || kv === undefined) return;
	expectTypeOf(kv.values.since).toEqualTypeOf<InstantString | undefined>();
	expectTypeOf(kv.values.recent).toEqualTypeOf<string[] | undefined>();
	// What was read goes back in, one key at a time.
	folder.kv.set('recent', kv.values.recent);
	folder.kv.set('since', instant);
	folder.kv.set('layout', { panes: [1] });
	// @ts-expect-error An unvalidated string still does not carry the brand.
	folder.kv.set('since', '2026-10-01T00:00:00.000Z');
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
	kv: { span: headed },
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
	rows.save(stored, { fields: { span }, body: '' });
	rows.save(stored, { fields: { span: ['a', 1, 2] }, body: '' });
	rows.create({ fields: { span: ['a'] }, body: '' });
	// @ts-expect-error The head is a string.
	rows.save(stored, { fields: { span: [1, 'a'] }, body: '' });
	// @ts-expect-error The head is required.
	rows.save(stored, { fields: { span: [] }, body: '' });
	// @ts-expect-error The rest are numbers.
	rows.create({ fields: { span: ['a', 'b'] }, body: '' });

	const { data: kv, error: kvError } = await folder.kv.get();
	if (kvError !== null || kv === undefined) return;
	expectTypeOf(kv.values.span).toEqualTypeOf<
		[string, ...number[]] | undefined
	>();
	folder.kv.set('span', kv.values.span);
	folder.kv.set('span', ['a', 1]);
	// @ts-expect-error The head is a string.
	folder.kv.set('span', [1, 'a']);
	// @ts-expect-error The head is required.
	folder.kv.set('span', []);
}
void tupleValues;

expectTypeOf<Opened['tables']['todos']>().toEqualTypeOf<
	FileTable<CreateRowOf<typeof definition.tables.todos>>
>();
expectTypeOf<Opened['kv']>().toEqualTypeOf<FileKv<KvOf<typeof definition>>>();
// Every handle exposes the definition it reads with.
expectTypeOf<Opened['definition']>().toEqualTypeOf<typeof definition>();
expectTypeOf<
	CreateRowOf<typeof definition.tables.todos>['due']
>().toEqualTypeOf<InstantString | null>();

// One opener signature at the automatic entry and at both explicit entries.
expectTypeOf(root.openFolder).toEqualTypeOf<OpenFolder>();
expectTypeOf(browser.openFolder).toEqualTypeOf<OpenFolder>();
expectTypeOf(tauri.openFolder).toEqualTypeOf<OpenFolder>();
expectTypeOf(browser.openFolder).toEqualTypeOf(root.openFolder);
expectTypeOf(tauri.openFolder).toEqualTypeOf(root.openFolder);
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
void root.openFolder({
	id: 'test.folder',
	// @ts-expect-error A definition that names its data is not a folder definition.
	definition: { id: 'test.folder', kv: {}, tables: {} },
});

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

// A lens types the tables and settings it reads; `definition` stays the
// folder's own declaration, and a table may refuse to add rows.
const board = defineFolder({
	kv: { theme: field.string() },
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
	if (created.error?.name === 'CannotCreate')
		expectTypeOf(created.error.fields).toEqualTypeOf<readonly string[]>();
	folder.tables.todos.create({
		// @ts-expect-error A lens field keeps its declared type.
		fields: { title: 'Milk', status: 'blocked' },
		body: '',
	});
	expectTypeOf(folder.kv).toEqualTypeOf<FileKv<KvOf<typeof board>>>();
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
expectTypeOf<EntryPoint<typeof tauri>>().toEqualTypeOf<Contract>();
expectTypeOf<Pick<typeof bun, keyof Contract>>().toEqualTypeOf<Contract>();

// The directory openers are their own contract: an explicit root and history.
expectTypeOf(bun.openDataFolder<FolderDefinition>)
	.parameter(0)
	.toEqualTypeOf<bun.DataFolderOptions>();
expectTypeOf(bun.openDataFolder<FolderDefinition>).returns.toEqualTypeOf<
	Promise<Result<Folder<FolderDefinition>, OpenFolderError>>
>();
expectTypeOf(bun.openFolder<typeof definition>)
	.parameter(0)
	.toEqualTypeOf<bun.DirectoryFolderOptions<typeof definition>>();
expectTypeOf(bun.openFolder<typeof definition>).returns.toEqualTypeOf<
	Promise<Result<Opened, OpenFolderError>>
>();

async function typedValues(
	folder: Opened,
	reading: KvReading<KvOf<typeof definition>>,
	instant: InstantString,
) {
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
	folder.kv.set('theme', 'dark');
	// Removing a key lets the app's default apply.
	folder.kv.set('theme', undefined);
	// @ts-expect-error Only declared settings exist.
	folder.kv.set('language', 'en');
	// @ts-expect-error Typed settings retain validation.
	folder.kv.set('theme', 12);
	// @ts-expect-error A set names one key, not a values object.
	folder.kv.set({ theme: 'dark' });
	// @ts-expect-error Complete source is saved as an ordinary file.
	folder.kv.replace(reading, '{}');
	// A reading names the bytes it read; absence is `undefined`.
	// @ts-expect-error A reading keeps its version.
	reading.sha256 = 'changed';
	// @ts-expect-error A reading carries no text.
	reading.text;
	expectTypeOf(reading.path).toEqualTypeOf<'kv.json'>();
	// Stored values are sparse and sit apart from the reading's own keys.
	expectTypeOf(reading.values).toEqualTypeOf<
		Partial<KvOf<typeof definition>>
	>();
	expectTypeOf(reading.values.theme).toEqualTypeOf<string | undefined>();
	expectTypeOf(reading.issues).toEqualTypeOf<readonly Issue[]>();
	// @ts-expect-error A reading carries no defaults.
	reading.defaults;
	// @ts-expect-error Values are not flattened beside the reading.
	reading.theme;
	const observed = await folder.kv.get();
	if (observed.error === null)
		expectTypeOf(observed.data).toEqualTypeOf<
			KvReading<KvOf<typeof definition>> | undefined
		>();
	else expectTypeOf(observed.error).toEqualTypeOf<KvReadError>();
	const { data: written, error: setError } = await folder.kv.set(
		'theme',
		'dark',
	);
	if (setError === null)
		expectTypeOf(written).toEqualTypeOf<KvReading<KvOf<typeof definition>>>();
	else {
		expectTypeOf(setError).toEqualTypeOf<KvWriteError>();
		// Text that is not one strict JSON object is repaired as text.
		if (setError.name === 'InvalidKv')
			expectTypeOf(setError.text).toEqualTypeOf<string>();
		if (setError.name === 'InvalidValues')
			expectTypeOf(setError.issues).toEqualTypeOf<readonly Issue[]>();
	}
	folder.files.replace(reading, '{}');

	// Captures are plain values; a read also carries detached bytes.
	const { data: file, error: readError } = await folder.files.read('a.md');
	if (readError !== null) return;
	expectTypeOf(file).toEqualTypeOf<CapturedFile>();
	const { data: replaced, error: replaceError } = await folder.files.replace(
		file,
		'next',
	);
	if (replaceError !== null) return;
	expectTypeOf(replaced).toEqualTypeOf<FileCapture>();
	expectTypeOf(await folder.files.remove(replaced)).toEqualTypeOf<
		Awaited<ReturnType<Opened['files']['remove']>>
	>();
	// A stored row is a capture of its row file with the row it holds.
	const entry = await folder.tables.todos.get('milk');
	type Fields = CreateRowOf<typeof definition.tables.todos>;
	if (entry.error === null) {
		expectTypeOf(entry.data).toEqualTypeOf<StoredRow<Fields> | undefined>();
	} else expectTypeOf(entry.error).toEqualTypeOf<RowReadError>();
	if (entry.data) {
		expectTypeOf(entry.data).toExtend<FileCapture>();
		expectTypeOf<keyof StoredRow<Fields>>().toEqualTypeOf<
			'path' | 'sha256' | 'row'
		>();
		// A valid row is complete: every declared field, and the body.
		expectTypeOf(entry.data.row.fields).toEqualTypeOf<{
			title: string;
			due: InstantString | null;
		}>();
		expectTypeOf(entry.data.row.body).toEqualTypeOf<string>();
		// @ts-expect-error A capture keeps its path.
		entry.data.path = '';
		// @ts-expect-error A valid row carries no diagnostics.
		entry.data.issues;
	}
	// Text that is not a valid row is an error that keeps the text and its capture.
	if (entry.error?.name === 'InvalidRow') {
		expectTypeOf(entry.error).toExtend<FileCapture>();
		expectTypeOf(entry.error.text).toEqualTypeOf<string>();
		expectTypeOf(entry.error.issues).toEqualTypeOf<Issues>();
		expectTypeOf<keyof Issue>().toEqualTypeOf<'message' | 'line' | 'field'>();
		// @ts-expect-error Issues cannot be changed in place.
		entry.error.issues.push({ message: '' });
		// A repair is a guarded raw save, or a guarded delete.
		folder.files.replace(entry.error, entry.error.text);
		folder.tables.todos.delete(entry.error);
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
		Result<TableListing<Fields>, TableEnumerationError>
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
		expectTypeOf(createError).toEqualTypeOf<TableCreateError>();
		// An occupied destination is the files' error, with the files' shape.
		if (createError.name === 'Exists')
			expectTypeOf(createError).toEqualTypeOf<
				Extract<FileError, { name: 'Exists' }>
			>();
		if (createError.name === 'InvalidValues')
			expectTypeOf(createError.issues).toEqualTypeOf<readonly Issue[]>();
		// @ts-expect-error A table has no naming rule of its own.
		createError.name === 'InvalidStem';
		// @ts-expect-error Nor a collision rule.
		createError.name === 'Collision';
		// @ts-expect-error Text is decoded only by reads.
		createError.name === 'InvalidUtf8';
	}
	// @ts-expect-error There is no structured update: replace a row that was read.
	folder.tables.todos.update;
	// @ts-expect-error Nor an unguarded write: every change after create names a capture.
	folder.tables.todos.delete('milk');
	// @ts-expect-error The options-object guard is gone.
	folder.tables.todos.delete('milk', { expectedSha256: 'a'.repeat(64) });
	if (entry.data) {
		// Every change after create names the bytes it replaces.
		const { data: saved, error: saveError } = await folder.tables.todos.save(
			entry.data,
			entry.data.row,
		);
		if (saveError === null) {
			expectTypeOf(saved.stored).toEqualTypeOf<StoredRow<Fields>>();
			expectTypeOf(saved.replaced).toEqualTypeOf<readonly Replaced[]>();
		} else {
			expectTypeOf(saveError).toEqualTypeOf<TableSaveError>();
			// @ts-expect-error A table never saves text it cannot read back.
			saveError.name === 'Unparsed';
		}
		// @ts-expect-error A table saves a row; complete text is an ordinary file.
		folder.tables.todos.save(entry.data, '---\n---\n');
		folder.files.replace(entry.data, '---\n---\n');
		// @ts-expect-error A stem is not a capture.
		folder.tables.todos.save('milk', entry.data.row);
		expectTypeOf(
			await folder.tables.todos.rename(entry.data, 'next'),
		).toEqualTypeOf<Result<FileCapture, TableRenameError>>();
		expectTypeOf(await folder.tables.todos.delete(entry.data)).toEqualTypeOf<
			Result<undefined, TableDeleteError>
		>();
	}
	// @ts-expect-error A captured hash is required for removal.
	folder.files.remove({ path: 'a.md' });
	folder.files.replace(
		// @ts-expect-error Captures carry a flat hash, not a version wrapper.
		{ path: 'a.md', version: { sha256: 'a'.repeat(64) } },
		'next',
	);
	// @ts-expect-error A path alone is not a capture: `overwrite` says that.
	folder.files.replace('a.md', 'next');
	// @ts-expect-error The old single write verb is gone.
	folder.files.write('a.md', 'next', { expected: 'any' });

	// Each write is one file change: a failure is that file's, and only a
	// move names the two paths it touched.
	const { error: fileCreateError } = await folder.files.create('a.md', 'a');
	if (fileCreateError !== null)
		expectTypeOf(fileCreateError).toEqualTypeOf<FileError>();
	const { error: moveError } = await folder.files.move(replaced, 'b.md');
	// A file move is always guarded, so a kept source names the moved capture.
	if (moveError !== null) {
		expectTypeOf(moveError).toEqualTypeOf<FileError | MoveError>();
		if (moveError.name === 'SourceNotRemoved')
			expectTypeOf(moveError.moved).toEqualTypeOf<FileCapture>();
	}
	// Every move is guarded, so a kept source always names the moved capture.
	expectTypeOf<TableRenameError>().toEqualTypeOf<FileError | MoveError>();
	expectTypeOf<
		Extract<MoveError, { name: 'SourceNotRemoved' }>['moved']
	>().toEqualTypeOf<FileCapture>();
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

// A table with a body conversion is not a folder table.
defineFolder({
	kv: {},
	tables: {
		// @ts-expect-error A folder stores the body as the file's Markdown text.
		notes: defineTable({
			fields: { title: field.string() },
			body: { encode: () => '', decode: () => undefined },
		}),
	},
});
defineFolder({
	// @ts-expect-error A folder definition names no folder; the opener does.
	id: 'test.named',
	kv: {},
	tables: {},
});
defineFolder({
	kv: {},
	tables: {
		// @ts-expect-error A table is authored with `defineTable`.
		notes: { fields: { title: field.string() } },
	},
});
