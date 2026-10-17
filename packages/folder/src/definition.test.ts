/**
 * Folder Definition Tests
 *
 * `defineFolder` returns the prepared definition, in the shape it was declared
 * in, and a folder opened from it names each table by its key in that
 * definition and reads values through its schema snapshots.
 *
 * Key behaviors:
 * - `defineFolder` returns an owned, frozen definition of the declared shape,
 *   and preparing it again returns it
 * - A key other than `title`, `tables`, and `local` is refused, not
 *   dropped
 * - A definition names no folder: an `id` is refused as any other key is, at
 *   the declaration and at the opener, and the opener's ID selects the dataset
 * - One prepared definition opens two folders that stay apart, and another
 *   definition reading one of them keeps the fields it does not declare
 * - A table name that every object inherits (`constructor`, `toString`) is an
 *   ordinary table: its handle and its directory
 * - One declared table under two names is two tables with two directories
 * - A schema edited after `defineFolder` does not change what the folder
 *   accepts, and a second definition reusing it reads the edit
 * - The prepared-table type is not a proof: a table rebuilt with a cloned
 *   field compiles, and reading a value through that field throws until
 *   `defineFolder` prepares it again
 * - A table publishes as one JSON Schema, so two fields defining one `$id`
 *   and a `#` reference outside any `$id` are refused
 *
 * See also:
 * - `packages/definition/src/prepare.test.ts` for preparation itself
 */
import { afterAll, afterEach, expect, test } from 'bun:test';
import { expectErr, expectOk } from 'wellcrafted/testing';
import { openFolder } from './browser.js';
import {
	browserStorage,
	createTestStorage,
	locationOf,
	opfsOf,
	type TestStorage,
} from './browser-storage.test-support.js';
import {
	defineFolder,
	defineTable,
	field,
	formatDeclaration,
	formatRow,
	parseDeclaration,
	parseRow,
} from './contract.js';
import { prepareFolderDefinition } from './definition.js';
import { installWebLocks } from './web-locks.test-support.js';

afterAll(installWebLocks());

const closers: (() => Promise<void>)[] = [];
afterEach(async () => {
	for (const close of closers.splice(0)) await close();
});

async function open<
	const TDefinition extends Parameters<typeof openFolder>[0]['definition'],
>(
	definition: TDefinition,
	{
		id = 'so.epicenter.definitiontest',
		storage = createTestStorage(),
	}: { id?: string; storage?: TestStorage } = {},
) {
	const folder = expectOk(
		await openFolder({
			id,
			definition,
			browser: {
				author: { name: 'Definition', email: 'definition@example.test' },
				...browserStorage(storage),
			},
		}),
	);
	closers.push(() => folder.close());
	return folder;
}

const text = (bytes: Uint8Array) => new TextDecoder().decode(bytes);

const paths = async (folder: Pick<Awaited<ReturnType<typeof open>>, 'files'>) =>
	expectOk(await folder.files.list()).files.map((file) => file.path);

test('defineFolder returns the prepared definition in the declared shape', () => {
	const declared = {
		title: 'Definition',
		tables: {
			todos: defineTable({
				fields: { title: field.string(), done: field.boolean() },
			}),
		},
	};
	const definition = defineFolder(declared);

	expect(Object.keys(definition)).toEqual(['title', 'tables']);
	expect(Object.keys(definition.tables)).toEqual(['todos']);
	expect(Object.keys(definition.tables.todos)).toEqual(['fields']);
	expect(Object.keys(definition.tables.todos.fields)).toEqual([
		'title',
		'done',
	]);
	// A field is the native schema, hint included, and a snapshot of it.
	const { title } = definition.tables.todos.fields;
	expect(title).toEqual(field.string());
	expect(title).not.toBe(declared.tables.todos.fields.title);
	for (const owned of [
		definition,
		title,
		definition.tables,
		definition.tables.todos,
		definition.tables.todos.fields,
	])
		expect(Object.isFrozen(owned)).toBe(true);
	expect(Object.isFrozen(declared.tables.todos.fields.title)).toBe(false);

	// An opener handed this definition gets it back and prepares nothing.
	expect(expectOk(prepareFolderDefinition(definition))).toBe(definition);
	expect(expectOk(prepareFolderDefinition(declared))).not.toBe(definition);
	expect(
		expectErr(
			prepareFolderDefinition({
				...declared,
				tables: { todos: { fields: { id: field.string() } } },
			} as never),
		).reason,
	).toContain("field name 'todos.id' is not usable");
});

test('an untyped definition with a key other than title, tables, and local is refused, not dropped', () => {
	expect(() => defineFolder({ tables: {}, titel: 'Typo' } as never)).toThrow(
		"also declares 'titel'",
	);
});

test('a settings table is written with only optional fields, and a published one that requires a setting still opens', () => {
	// Where a definition is written, a required setting is refused: a row of
	// one concern holds only that concern's settings.
	expect(() =>
		defineFolder({
			tables: {
				settings: defineTable({ fields: { theme: field.string() } }),
			},
		} as never),
	).toThrow("'theme' is a setting, which may be unset");
	// A declaration already published that requires one is read as written,
	// so the folder still opens and a row missing it is one to repair.
	expectOk(
		prepareFolderDefinition({
			tables: { settings: { fields: { theme: field.string() } } },
		} as never),
	);
});

test('a definition names no folder: an id is refused where it is written and where it is opened', async () => {
	const declared = { tables: {} };
	expect(() =>
		defineFolder({ ...declared, id: 'so.epicenter.named' } as never),
	).toThrow("also declares 'id'");
	expect(
		expectErr(
			prepareFolderDefinition({
				...declared,
				id: 'so.epicenter.named',
			} as never),
		).reason,
	).toContain("declares 'id'");

	const storage = createTestStorage();
	const refused = expectErr(
		await openFolder({
			id: 'so.epicenter.named',
			definition: { ...declared, id: 'so.epicenter.named' } as never,
			browser: browserStorage(storage),
		}),
	);
	expect(refused.name).toBe('InvalidDefinition');
	expect(opfsOf(storage).directories()).toEqual([]);
});

test('one prepared definition opens two folders that stay apart, and another definition keeps what it does not declare', async () => {
	const definition = defineFolder({
		tables: {
			todos: defineTable({
				fields: { title: field.string(), done: field.boolean() },
			}),
			settings: defineTable({
				fields: { theme: field.optional(field.string()) },
			}),
		},
	});
	const storage = createTestStorage();
	const personal = await open(definition, {
		id: 'so.epicenter.todos',
		storage,
	});
	const work = await open(definition, {
		id: 'so.epicenter.todos.work',
		storage,
	});
	expect(personal.location).toEqual(locationOf('so.epicenter.todos'));
	expect(work.location).toEqual(locationOf('so.epicenter.todos.work'));

	expectOk(
		await personal.tables.todos.create(
			{ fields: { title: 'Milk', done: false }, body: '' },
			{ stem: 'milk' },
		),
	);
	const made = text(expectOk(await personal.files.read('todos/milk.md')).bytes);
	expectOk(
		await personal.tables.settings.create(
			{ fields: { theme: 'dark' }, body: '' },
			{ stem: 'display' },
		),
	);
	expectOk(
		await work.tables.todos.create(
			{ fields: { title: 'Report', done: false }, body: '' },
			{ stem: 'report' },
		),
	);
	expect(await paths(personal)).toEqual([
		'epicenter.json',
		'settings/display.md',
		'todos/milk.md',
	]);
	expect(await paths(work)).toEqual(['epicenter.json', 'todos/report.md']);
	expect(expectOk(await work.tables.todos.get('milk'))).toBeUndefined();
	expect(expectOk(await work.tables.settings.get('display'))).toBeUndefined();
	await personal.close();

	// Another tool reads the same folder through a narrower definition.
	const titles = defineFolder({
		tables: { todos: defineTable({ fields: { title: field.string() } }) },
	});
	const reopened = await open(titles, { id: 'so.epicenter.todos', storage });
	const milk = expectOk(await reopened.tables.todos.get('milk'))!;
	// Keys the narrower definition does not declare are still on the row.
	expect<object>(milk.row.fields).toEqual({ title: 'Milk', done: false });
	expectOk(
		await reopened.tables.todos.write('milk', milk.row, {
			...milk.row,
			fields: { ...milk.row.fields, title: 'Oat milk' },
		}),
	);
	expect(text(expectOk(await reopened.files.read('todos/milk.md')).bytes)).toBe(
		made.replace('Milk', 'Oat milk'),
	);
	expect(
		text(expectOk(await reopened.files.read('settings/display.md')).bytes),
	).toContain('theme: dark');
});

test('tables named like Object.prototype members, and one table under two names, each keep their own directory', async () => {
	const row = defineTable({ fields: { title: field.string() } });
	const folder = await open(
		defineFolder({
			tables: { constructor: row, toString: row, notes: row },
		}),
	);
	expect(Object.keys(folder.tables)).toEqual([
		'constructor',
		'toString',
		'notes',
	]);

	const made = expectOk(
		await folder.tables.constructor.create(
			{ fields: { title: 'Made' }, body: '' },
			{ stem: 'a' },
		),
	);
	expect(made?.path).toBe('constructor/a.md');
	expectOk(
		await folder.tables.toString.create(
			{ fields: { title: 'Text' }, body: '' },
			{ stem: 'b' },
		),
	);
	expectOk(
		await folder.tables.notes.create(
			{ fields: { title: 'Note' }, body: '' },
			{ stem: 'b' },
		),
	);
	expect((await paths(folder)).sort()).toEqual([
		'constructor/a.md',
		'epicenter.json',
		'notes/b.md',
		'toString/b.md',
	]);
	// The same stem in two tables is two rows, each read by its own table.
	expect(expectOk(await folder.tables.toString.get('b'))?.row.fields).toEqual({
		title: 'Text',
	});
	expect(expectOk(await folder.tables.notes.get('b'))?.row.fields).toEqual({
		title: 'Note',
	});
	expect(expectOk(await folder.tables.constructor.get('b'))).toBeUndefined();
	expect(
		expectOk(await folder.tables.constructor.list()).map((entry) => entry.stem),
	).toEqual(['a']);
	// Each name checks its own rows.
	const refused = expectErr(
		await folder.tables.toString.create(
			{ fields: { title: 7 as never }, body: '' },
			{ stem: 'c' },
		),
	);
	expect(refused.name).toBe('InvalidValues');
});

test('a schema edited after defineFolder changes nothing the folder accepts, and a later definition reads the edit', async () => {
	const title = field.string({ maxLength: 4 });
	const table = defineTable({ fields: { title } });
	const first = defineFolder({
		tables: { todos: table },
	});
	// The author still holds an ordinary mutable schema, and declares it again.
	Object.assign(title, { maxLength: 9 });
	const second = defineFolder({
		tables: { todos: table },
	});
	expect(first.tables.todos.fields.title).not.toBe(
		second.tables.todos.fields.title,
	);

	const older = await open(first);
	const newer = await open(second);
	const row = { fields: { title: 'Longer' }, body: '' };
	expect(
		expectErr(await older.tables.todos.create(row, { stem: 'a' })).name,
	).toBe('InvalidValues');
	const made = expectOk(await newer.tables.todos.create(row, { stem: 'a' }));
	const saved = text(expectOk(await newer.files.read(made!.path)).bytes);
	expect(expectOk(parseRow(second.tables.todos, saved))).toEqual(row);
	expect(expectErr(parseRow(first.tables.todos, saved))).toHaveLength(1);
});

test('a prepared table rebuilt with a cloned field still type-checks, and reading a value through that field throws until defineFolder prepares it again', () => {
	const definition = defineFolder({
		tables: {
			todos: defineTable({
				fields: { title: field.string(), done: field.boolean() },
			}),
		},
	});
	const prepared = definition.tables.todos;
	const text = '---\ntitle: Milk\ndone: false\n---\n';

	// A spread that keeps the prepared field objects reads as the table does.
	expect(parseRow({ ...prepared }, text)).toEqual(parseRow(prepared, text));

	// The prepared-table mark survives the spread, so the compiler accepts a
	// rebuilt table; the clone is an object no preparation ever saw.
	const rebuilt = {
		...prepared,
		fields: { ...prepared.fields, title: { ...prepared.fields.title } },
	};
	// A missing value is reported without the cloned field ever reading one.
	expect(
		expectErr(parseRow(rebuilt, '---\ndone: false\n---\n')).map(
			(issue) => issue.field,
		),
	).toEqual(['title']);
	// Once one appears, the read is refused as a programmer error, not an issue.
	expect(() => parseRow(rebuilt, text)).toThrow('This schema was not prepared');
	// Formatting checks no value, so it writes the prepared table's text
	// without noticing.
	const milk = { fields: { title: 'Milk', done: false }, body: '' };
	expect(expectOk(formatRow(rebuilt, milk))).toBe(
		expectOk(formatRow(prepared, milk)),
	);

	// Preparing the rebuilt declaration again is the remedy.
	const again = defineFolder({
		tables: { todos: defineTable({ fields: rebuilt.fields }) },
	});
	expect(expectOk(parseRow(again.tables.todos, text)).fields).toEqual({
		title: 'Milk',
		done: false,
	});
});

test('a table is one JSON Schema in epicenter.json, so its fields cannot reuse an $id or point at the table root', () => {
	// What `Type.Cyclic({ [name]: ... }, name)` declares, as a file holds it.
	const cyclic = (name: string) => ({
		$defs: {
			[name]: {
				$id: name,
				type: 'object',
				properties: {
					value: { type: 'number' },
					next: { anyOf: [{ $ref: name }, { type: 'null' }] },
				},
				required: ['value', 'next'],
			},
		},
		$ref: name,
	});
	const tableOf = (fields: Record<string, object>) => ({
		tables: { chains: defineTable({ fields: fields as never }) },
	});

	// Two fields that each define `Node` publish two schemas with one `$id`,
	// which a JSON Schema validator refuses for the whole table.
	expect(
		expectErr(
			prepareFolderDefinition(
				tableOf({ a: cyclic('Node'), b: cyclic('Node') }),
			),
		).reason,
	).toBe(
		"Fields 'chains.a' and 'chains.b' both define the $id 'Node'. epicenter.json holds a table as one JSON Schema, where an $id names one schema; rename one of them.",
	);
	// A `#` pointer outside any `$id` is the field's root in memory and the
	// table's root in the file.
	expect(
		expectErr(
			prepareFolderDefinition(
				tableOf({
					text: { $defs: { t: { type: 'string' } }, $ref: '#/$defs/t' },
				}),
			),
		).reason,
	).toBe(
		"Field 'chains.text' refers to '#/$defs/t' outside any $id. In epicenter.json '#' is the whole table, not the field; give the field an $id.",
	);

	// Distinct names, the same name in two tables, and a pointer under an
	// `$id` all publish as standalone schemas.
	expectOk(
		prepareFolderDefinition(tableOf({ a: cyclic('Node'), b: cyclic('Other') })),
	);
	expectOk(
		prepareFolderDefinition({
			tables: {
				one: defineTable({ fields: { chain: cyclic('Node') } }),
				two: defineTable({ fields: { chain: cyclic('Node') } }),
			},
		}),
	);
	expectOk(
		prepareFolderDefinition(
			tableOf({
				text: {
					$id: 'text',
					$defs: { t: { type: 'string' } },
					$ref: '#/$defs/t',
				},
				// A `$ref` or `$id` held as data is a value.
				data: { const: { $id: 'Node', $ref: '#/nowhere' } },
				chain: cyclic('Node'),
			}),
		),
	);
});

test('a closed table reports an undeclared key at its line, and epicenter.json keeps it closed', () => {
	const fields = { title: field.string() };
	const definition = defineFolder({
		tables: {
			open: defineTable({ fields }),
			closed: defineTable({ fields, additionalProperties: false }),
		},
	});
	const text = '---\ntitle: Launch\nsubtitel: A typo\n---\n';

	// An open table keeps the undeclared key on the row, outside its type.
	const kept: Record<string, unknown> = expectOk(
		parseRow(definition.tables.open, text),
	).fields;
	expect(kept).toEqual({ title: 'Launch', subtitel: 'A typo' });
	expect(expectErr(parseRow(definition.tables.closed, text))).toEqual([
		{ message: 'subtitel is not declared', line: 3, field: 'subtitel' },
	]);

	const declaration = formatDeclaration(definition);
	expect(JSON.parse(declaration).tables.closed.additionalProperties).toBe(
		false,
	);
	expect(JSON.parse(declaration).tables.open).not.toHaveProperty(
		'additionalProperties',
	);
	const reread = prepareFolderDefinition(
		expectOk(parseDeclaration(declaration)),
	);
	expect(expectOk(reread).tables.closed?.additionalProperties).toBe(false);
	expect(
		expectErr(
			parseDeclaration(
				JSON.stringify({
					tables: {
						notes: { type: 'object', properties: {}, additionalProperties: {} },
					},
				}),
			),
		).reason,
	).toContain('the only value is false');
});
