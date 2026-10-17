/**
 * Read-Through Tests
 *
 * A folder that is not the opening app's own is read through the opener's
 * definition: its own declaration must contain the definition's shape
 * (ADR-0538), and nothing publishes the definition there. In Bun a folder
 * is named by its directory, so only a directory named after `app` is the
 * app's own.
 *
 * Key behaviors:
 * - An app opener publishes only in the directory named after the app, and
 *   `folder.own` says which; anywhere else it reads through the definition
 * - A definition over a bigger folder opens with the definition's tables
 *   alone; the handle's `definition` is the folder's own declaration
 * - Rows read through the definition keep the fields it does not name, so a
 *   write keeps them, and every write is checked against the folder's
 *   declaration
 * - `epicenter.json` is never written
 * - A definition the declaration does not contain is `DefinitionMismatch`,
 *   naming the folder, and the app when an app opened it, and listing every
 *   problem; opening creates nothing
 * - A table whose folder requires a field the definition does not declare
 *   cannot add rows: `canCreate` is false and `create` is `InvalidValues`
 *   naming each such field
 * - A browser folder read through a definition behaves the same
 * - What the definition keeps on this machine (`local`) never enters the
 *   folder's history, while a file the folder already tracks stays tracked,
 *   and the folder's `epicenter.json` and `.gitignore` are not changed
 */
import { afterAll, beforeAll, expect, test } from 'bun:test';
import { existsSync } from 'node:fs';
import { mkdir, readdir, readFile, writeFile } from 'node:fs/promises';
import { basename, join } from 'node:path';
import { expectErr, expectOk } from 'wellcrafted/testing';
import { openFolder as openBrowserFolder } from './browser.js';
import {
	browserStorage,
	createTestStorage,
} from './browser-storage.test-support.js';
import { openFolder, readFolder } from './bun.js';
import { defineFolder, defineTable, field } from './contract.js';
import { GIT_ENV, git, scratch } from './git-http.test-support.js';

const author = { name: 'Board', email: 'board@localhost' };

/** A folder that declares more than any definition below reads, written by hand. */
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

test('an app opener publishes in the directory named after the app, and reads through its definition anywhere else', async () => {
	const parent = await scratch('read-through-app-');
	const own = join(parent, 'so.epicenter.board');
	await mkdir(own);
	const opened = expectOk(
		await openFolder({
			root: own,
			app: 'so.epicenter.board',
			definition: board,
			git: { author },
		}),
	);
	expect(opened.id).toBe('so.epicenter.board');
	expect(opened.own).toBe(true);
	expect(opened.definition).toBe(board);
	expectOk(
		await opened.tables.todos.create(
			{ fields: { title: 'Eggs', status: 'todo' }, body: '' },
			{ stem: 'eggs' },
		),
	);
	expect(existsSync(join(own, 'epicenter.json'))).toBe(true);
	await opened.close();

	const root = await folderRoot('read-through-other-');
	const other = expectOk(
		await openFolder({
			root,
			app: 'so.epicenter.board',
			definition: board,
			git: { author },
		}),
	);
	expect(other.id).toBe(basename(root));
	expect(other.own).toBe(false);
	expectOk(await other.tables.todos.set('milk', { status: 'done' }));
	expect(await readFile(join(root, 'epicenter.json'), 'utf8')).toBe(DECLARED);
	await other.close();
});

test('a definition over a bigger folder opens with its own tables, and the folder keeps what the definition does not name', async () => {
	const root = await folderRoot('read-through-bigger-');
	const folder = expectOk(
		await openFolder({ root, git: { author }, definition: board }),
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

test("every write is checked against the folder's declaration, not the definition's", async () => {
	const root = await folderRoot('read-through-validation-');
	const folder = expectOk(
		await openFolder({ root, git: { author }, definition: board }),
	);
	const todos = folder.tables.todos;
	// The definition admits 'later'; the folder does not.
	const refused = expectErr(await todos.set('milk', { status: 'later' }));
	expect(refused.name).toBe('InvalidValues');
	// A field the definition does not name is checked too.
	const milk = expectOk(await todos.get('milk'))!;
	const fields = { ...milk.row.fields, priority: 9 };
	expect(
		expectErr(await todos.write('milk', milk.row, { ...milk.row, fields }))
			.name,
	).toBe('InvalidValues');
	// The definition's string theme is checked against the folder's options.
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

test('a definition that does not declare a required field cannot add rows', async () => {
	const root = await folderRoot('read-through-create-');
	const folder = expectOk(
		await openFolder({ root, git: { author }, definition: board }),
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
		await openFolder({ root, git: { author }, definition: full }),
	);
	expect(knowing.tables.todos.canCreate).toBe(true);
	const eggs = expectOk(
		await knowing.tables.todos.create(
			{ fields: { title: 'Eggs', status: 'todo', priority: 1 }, body: '' },
			{ stem: 'eggs' },
		),
	);
	expect(eggs?.path).toBe('todos/eggs.md');
	// The definition's number is still held to the folder's integer from 1 to 3.
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

test('a definition the declaration does not contain is DefinitionMismatch, naming the folder and listing every problem, and opens nothing', async () => {
	const root = await folderRoot('read-through-mismatch-');
	const reader = defineFolder({
		title: 'Calendar',
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
		await openFolder({ root, git: { author }, definition: reader }),
	);
	expect(refused.name).toBe('DefinitionMismatch');
	if (refused.name !== 'DefinitionMismatch') return;
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
	// Read by no app, the refusal names the folder alone.
	expect(refused.message).toStartWith(
		`The folder '${basename(root)}' does not declare what this definition reads: `,
	);
	expect(refused.message).toContain("The folder declares no 'events' table");
	expect(existsSync(join(root, '.git'))).toBe(false);
	expect(await readFile(join(root, 'epicenter.json'), 'utf8')).toBe(DECLARED);
});

test('a folder without epicenter.json contains only a definition that reads nothing', async () => {
	const root = await scratch('read-through-undeclared-');
	expect(
		expectErr(await openFolder({ root, git: { author }, definition: board }))
			.name,
	).toBe('DefinitionMismatch');
	const empty = defineFolder({ tables: {} });
	const folder = expectOk(
		await openFolder({ root, git: { author }, definition: empty }),
	);
	expect(folder.tables).toEqual({});
	await folder.close();
});

test('a closed folder table opens through a definition that reads a subset of it', async () => {
	const root = await scratch('read-through-closed-');
	await writeFile(
		join(root, 'epicenter.json'),
		'{"tables":{"pages":{"type":"object","properties":{"title":{"type":"string"},"tags":{"type":"array","items":{"type":"string"}}},"required":["title"],"additionalProperties":false}}}',
	);
	await mkdir(join(root, 'pages'));
	await writeFile(
		join(root, 'pages/a.md'),
		'---\ntitle: A\ntags:\n  - x\n---\n',
	);
	const reader = defineFolder({
		tables: { pages: defineTable({ fields: { title: field.string() } }) },
	});
	const folder = expectOk(
		await openFolder({ root, git: { author }, definition: reader }),
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

test('a browser folder read through a definition reads, writes, and refuses alike', async () => {
	const environment = createTestStorage();
	const storage = { ...browserStorage(environment), author };
	const writer = expectOk(
		await openBrowserFolder({ id: 'todos', browser: storage }),
	);
	expectOk(await writer.write('epicenter.json', null, DECLARED));
	expectOk(await writer.write('todos/milk.md', null, ROW));
	await writer.close();

	const folder = expectOk(
		await openBrowserFolder({
			id: 'todos',
			browser: storage,
			definition: board,
		}),
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
			await openBrowserFolder({
				id: 'todos',
				browser: storage,
				definition: mismatch,
			}),
		).name,
	).toBe('DefinitionMismatch');
});

test("a definition's local files never enter the folder's history, and what it tracks stays", async () => {
	const root = await folderRoot('read-through-local-');
	await mkdir(join(root, 'audio'));
	await writeFile(join(root, 'audio/kept.wav'), 'committed before');
	await git(root, 'init', '--quiet', '--initial-branch=main');
	await git(root, 'add', '-A');
	await git(root, 'commit', '--quiet', '-m', 'base');
	const recorder = defineFolder({
		title: 'Recorder',
		local: ['audio/'],
		tables: board.tables,
	});
	const folder = expectOk(
		await openFolder({ root, git: { author }, definition: recorder }),
	);
	expect(folder.own).toBe(false);
	expectOk(await folder.write('audio/new.wav', null, 'recorded here'));
	expectOk(await folder.write('audio/kept.wav', 'committed before', 'changed'));
	expectOk(await folder.tables.todos.set('milk', { status: 'done' }));

	const status = expectOk(await folder.git.status());
	expect(status.changes.map((change) => change.path).sort()).toEqual([
		'audio/kept.wav',
		'todos/milk.md',
	]);
	expect((await folder.git.commit()).status).toBe('committed');
	expect((await git(root, 'ls-files')).split('\n').sort()).toEqual([
		'audio/kept.wav',
		'epicenter.json',
		'todos/milk.md',
	]);
	expect(await readFile(join(root, 'epicenter.json'), 'utf8')).toBe(DECLARED);
	expect(existsSync(join(root, '.gitignore'))).toBe(false);
	await folder.close();
});
