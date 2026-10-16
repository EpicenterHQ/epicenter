/**
 * Lens Tests
 *
 * `openDataFolder({ lens })` opens an existing folder whose own declaration
 * contains the lens's shape (ADR-0538).
 *
 * Key behaviors:
 * - A lens over a bigger folder opens with the lens's tables alone; the
 *   handle's `definition` is the folder's own declaration
 * - Rows read through the lens keep the fields it does not name, so a write
 *   keeps them, and every write is checked against the folder's declaration
 * - `epicenter.json` is never written
 * - A lens the declaration does not contain is `ShapeMismatch`, listing every
 *   problem, and opening creates nothing
 * - A table whose folder requires a field the lens does not declare cannot
 *   add rows: `canCreate` is false and `create` is `InvalidValues` naming
 *   each such field
 * - A browser folder opened through a lens behaves the same
 */
import { afterAll, beforeAll, expect, test } from 'bun:test';
import { existsSync } from 'node:fs';
import { mkdir, readdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { expectErr, expectOk } from 'wellcrafted/testing';
import { openDataFolder as openBrowserDataFolder } from './browser.js';
import {
	browserStorage,
	createTestStorage,
} from './browser-storage.test-support.js';
import { openDataFolder, readFolder } from './bun.js';
import { defineFolder, defineTable, field } from './contract.js';
import { GIT_ENV, scratch } from './git-http.test-support.js';

const author = { name: 'Board', email: 'board@localhost' };

/** A folder that declares more than any lens below reads, written by hand. */
const DECLARED = `{"title":"Todos","tables":{"settings":{"type":"object","properties":{"theme":{"enum":["light","dark"]},"density":{"type":"number"}},"required":[]},"todos":{"type":"object","properties":{"title":{"type":"string"},"status":{"enum":["todo","done"]},"priority":{"type":"integer","minimum":1,"maximum":3},"note":{"type":"string"}},"required":["title","status","priority"]},"projects":{"type":"object","properties":{"name":{"type":"string"}},"required":["name"]}}}`;

const ROW =
	'---\ntitle: Milk\nstatus: todo\npriority: 2\nnote: Oat\nsource: phone\n---\nBuy it.\n';

/** Reads the title and status, and knows nothing of priority. */
const board = defineFolder({
	tables: {
		settings: defineTable({
			fields: { theme: field.optional(field.string()) },
		}),
		todos: defineTable({
			fields: {
				title: field.string(),
				status: field.select(['todo', 'done', 'later']),
			},
		}),
	},
});

/** Knows every field the folder requires. */
const full = defineFolder({
	tables: {
		todos: defineTable({
			fields: {
				title: field.string(),
				status: field.select(['todo', 'done']),
				priority: field.number(),
			},
		}),
	},
});

const originalEnv = { ...process.env };
beforeAll(() => {
	Object.assign(process.env, {
		GIT_CONFIG_GLOBAL: GIT_ENV.GIT_CONFIG_GLOBAL,
		GIT_CONFIG_NOSYSTEM: '1',
	});
});
afterAll(() => {
	for (const key of ['GIT_CONFIG_GLOBAL', 'GIT_CONFIG_NOSYSTEM'])
		if (originalEnv[key] === undefined) delete process.env[key];
		else process.env[key] = originalEnv[key];
});

async function folderRoot(prefix: string) {
	const root = await scratch(prefix);
	await writeFile(join(root, 'epicenter.json'), DECLARED);
	await mkdir(join(root, 'todos'));
	await writeFile(join(root, 'todos/milk.md'), ROW);
	return root;
}

test('a lens over a bigger folder opens with its own tables, and the folder keeps what the lens does not name', async () => {
	const root = await folderRoot('lens-bigger-');
	const folder = expectOk(
		await openDataFolder({ root, git: { author }, lens: board }),
	);
	expect(Object.keys(folder.tables)).toEqual(['settings', 'todos']);
	expect(folder.definition).toEqual(
		expectOk(await readFolder(root)).definition,
	);

	const todos = folder.tables.todos;
	const milk = expectOk(await todos.get('milk'))!;
	expect(milk.row.fields.title).toBe('Milk');
	expectOk(await todos.set('milk', { status: 'done' }));
	expect(await readFile(join(root, 'todos/milk.md'), 'utf8')).toBe(
		'---\ntitle: Milk\nstatus: done\npriority: 2\nnote: Oat\nsource: phone\n---\nBuy it.\n',
	);

	expectOk(
		await folder.tables.settings.create(
			{ fields: { theme: 'dark' }, body: '' },
			{ stem: 'display' },
		),
	);
	expect(
		expectOk(await folder.tables.settings.get('display'))!.row.fields,
	).toEqual({ theme: 'dark' });
	expect((await folder.git.commit()).status).toBe('committed');
	expect(await readFile(join(root, 'epicenter.json'), 'utf8')).toBe(DECLARED);
	await folder.close();
});

test("every write is checked against the folder's declaration, not the lens's", async () => {
	const root = await folderRoot('lens-validation-');
	const folder = expectOk(
		await openDataFolder({ root, git: { author }, lens: board }),
	);
	const todos = folder.tables.todos;
	// The lens admits 'later'; the folder does not.
	const refused = expectErr(await todos.set('milk', { status: 'later' }));
	expect(refused.name).toBe('InvalidValues');
	// A field the lens does not name is checked too.
	const milk = expectOk(await todos.get('milk'))!;
	const fields = { ...milk.row.fields, priority: 9 };
	expect(
		expectErr(await todos.write('milk', milk.row, { ...milk.row, fields }))
			.name,
	).toBe('InvalidValues');
	// The lens's string theme is checked against the folder's options.
	expect(
		expectErr(
			await folder.tables.settings.create(
				{ fields: { theme: 'sepia' }, body: '' },
				{ stem: 'display' },
			),
		).name,
	).toBe('InvalidValues');
	expect(await readFile(join(root, 'todos/milk.md'), 'utf8')).toBe(ROW);
	await folder.close();
});

test('a lens that does not declare a required field cannot add rows', async () => {
	const root = await folderRoot('lens-create-');
	const folder = expectOk(
		await openDataFolder({ root, git: { author }, lens: board }),
	);
	expect(folder.tables.todos.canCreate).toBe(false);
	const refused = expectErr(
		await folder.tables.todos.create({
			fields: { title: 'Eggs', status: 'todo' },
			body: '',
		}),
	);
	expect(refused).toMatchObject({
		name: 'InvalidValues',
		issues: [{ field: 'priority' }],
	});
	expect(await readdir(join(root, 'todos'))).toEqual(['milk.md']);
	await folder.close();

	const knowing = expectOk(
		await openDataFolder({ root, git: { author }, lens: full }),
	);
	expect(knowing.tables.todos.canCreate).toBe(true);
	const eggs = expectOk(
		await knowing.tables.todos.create(
			{ fields: { title: 'Eggs', status: 'todo', priority: 1 }, body: '' },
			{ stem: 'eggs' },
		),
	);
	expect(eggs?.path).toBe('todos/eggs.md');
	// The lens's number is still held to the folder's integer from 1 to 3.
	expect(
		expectErr(
			await knowing.tables.todos.create({
				fields: { title: 'Ham', status: 'todo', priority: 1.5 },
				body: '',
			}),
		).name,
	).toBe('InvalidValues');
	await knowing.close();
});

test('a lens the declaration does not contain is ShapeMismatch, listing every problem, and opens nothing', async () => {
	const root = await folderRoot('lens-mismatch-');
	const lens = defineFolder({
		tables: {
			settings: defineTable({
				fields: { accent: field.optional(field.string()) },
			}),
			todos: defineTable({
				fields: {
					title: field.number(),
					due: field.date(),
					note: field.string(),
				},
			}),
			events: defineTable({ fields: { title: field.string() } }),
		},
	});
	const refused = expectErr(
		await openDataFolder({ root, git: { author }, lens }),
	);
	expect(refused.name).toBe('ShapeMismatch');
	if (refused.name !== 'ShapeMismatch') return;
	expect(
		refused.problems.map((problem) => [
			problem.kind,
			problem.table,
			'field' in problem ? problem.field : undefined,
		]),
	).toEqual([
		['missingField', 'settings', 'accent'],
		['incompatibleField', 'todos', 'title'],
		['missingField', 'todos', 'due'],
		['incompatibleField', 'todos', 'note'],
		['missingTable', 'events', undefined],
	]);
	expect(refused.message).toContain("The folder declares no 'events' table");
	expect(existsSync(join(root, '.git'))).toBe(false);
	expect(await readFile(join(root, 'epicenter.json'), 'utf8')).toBe(DECLARED);
});

test('a folder without epicenter.json contains only a lens that reads nothing', async () => {
	const root = await scratch('lens-undeclared-');
	expect(
		expectErr(await openDataFolder({ root, git: { author }, lens: board }))
			.name,
	).toBe('ShapeMismatch');
	const empty = defineFolder({ tables: {} });
	const folder = expectOk(
		await openDataFolder({ root, git: { author }, lens: empty }),
	);
	expect(folder.tables).toEqual({});
	await folder.close();
});

test('a closed folder table opens through a lens that reads a subset of it', async () => {
	const root = await scratch('lens-closed-');
	await writeFile(
		join(root, 'epicenter.json'),
		'{"tables":{"pages":{"type":"object","properties":{"title":{"type":"string"},"tags":{"type":"array","items":{"type":"string"}}},"required":["title"],"additionalProperties":false}}}',
	);
	await mkdir(join(root, 'pages'));
	await writeFile(
		join(root, 'pages/a.md'),
		'---\ntitle: A\ntags:\n  - x\n---\n',
	);
	const lens = defineFolder({
		tables: { pages: defineTable({ fields: { title: field.string() } }) },
	});
	const folder = expectOk(
		await openDataFolder({ root, git: { author }, lens }),
	);
	const pages = folder.tables.pages;
	expect(pages.canCreate).toBe(true);
	expectOk(await pages.set('a', { title: 'Renamed' }));
	expect(await readFile(join(root, 'pages/a.md'), 'utf8')).toBe(
		'---\ntitle: Renamed\ntags:\n  - x\n---\n',
	);
	// The closed table still refuses a key it does not declare.
	expect(
		expectErr(
			await pages.create({
				fields: { title: 'B', extra: 1 } as { title: string },
				body: '',
			}),
		).name,
	).toBe('InvalidValues');
	await folder.close();
});

test('a browser folder opened through a lens reads, writes, and refuses alike', async () => {
	const environment = createTestStorage();
	const storage = { ...browserStorage(environment), author };
	const writer = expectOk(
		await openBrowserDataFolder({ id: 'todos', browser: storage }),
	);
	expectOk(await writer.files.create('epicenter.json', DECLARED));
	expectOk(await writer.files.create('todos/milk.md', ROW));
	await writer.close();

	const folder = expectOk(
		await openBrowserDataFolder({ id: 'todos', browser: storage, lens: board }),
	);
	expect(Object.keys(folder.tables)).toEqual(['settings', 'todos']);
	expect(folder.tables.todos.canCreate).toBe(false);
	expectOk(await folder.tables.todos.set('milk', { status: 'done' }));
	expect(
		new TextDecoder().decode(
			expectOk(await folder.files.read('todos/milk.md')).bytes,
		),
	).toContain('priority: 2\nnote: Oat\nsource: phone\n');
	expect(
		new TextDecoder().decode(
			expectOk(await folder.files.read('epicenter.json')).bytes,
		),
	).toBe(DECLARED);
	await folder.close();

	const mismatch = defineFolder({
		tables: { todos: defineTable({ fields: { title: field.boolean() } }) },
	});
	expect(
		expectErr(
			await openBrowserDataFolder({
				id: 'todos',
				browser: storage,
				lens: mismatch,
			}),
		).name,
	).toBe('ShapeMismatch');
});
