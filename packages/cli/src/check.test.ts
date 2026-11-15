/**
 * `epicenter check` Tests
 *
 * Runs the real command against a temporary Epicenter to verify the report a
 * person or an agent repairs records from, and the exit code a script gates on.
 *
 * Key behaviors:
 * - An app whose records all fit exits 0
 * - Misfit values, missing fields, and unreadable front matter are counted by
 *   kind, most frequent first, with the same kind on two files counted once
 *   per file, and exit 1
 * - A collection that matches no file says "0 files"; a one-file collection
 *   is checked; a `.local` file's values are never printed
 * - `--json` keys the report by app and collection
 * - With no app named, every app is checked and one that does not load is
 *   listed under its problems without stopping the rest
 */
import { afterEach, expect, setDefaultTimeout, test } from 'bun:test';
import { rm } from 'node:fs/promises';
import { join } from 'node:path';
import { fixture } from './runner.test-support.ts';

// Each test runs the real command as separate processes.
setDefaultTimeout(30_000);

const roots: string[] = [];
afterEach(async () => {
	await Promise.all(
		roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
	);
});

const tasks = `
const items = defineCollection({ path: 'data/items/{id}.md', fields: { title: field.text(), due: field.date({ optional: true }) } });
const notes = defineCollection({ path: 'data/notes/{slug}.md', fields: { title: field.text() } });
const settings = defineCollection({ path: 'data/settings.md', fields: { goal: field.integer({ optional: true }) } });
const google = defineCollection({ path: 'data/google.local.md', fields: { refreshToken: field.text({ optional: true }) } });
export default defineApp({ description: 'Tasks', collections: { items, notes, settings, google }, actions: {} });
`;

const books = `
const books = defineCollection({ path: 'data/books/{slug}.md', fields: { title: field.text() } });
export default defineApp({ description: 'Books', collections: { books }, actions: {} });
`;

async function setup() {
	const f = await fixture();
	roots.push(f.root);
	const tasksFolder = await f.app('tasks', tasks);
	await f.folder(join(tasksFolder, 'data'), {
		'items/a.md': '---\ntitle: "A"\ndue: "next week"\n---\n',
		'items/b.md': '---\ntitle: "B"\ndue: "soon"\n---\n',
		'items/c.md': '---\ndue: "2026-11-12"\n---\n',
		'items/d.md': '---\ntitle: [unclosed\n---\nBody\n',
		'items/e.md': '---\ntitle: "E"\n---\n',
		'settings.md': '---\ngoal: "lots"\n---\n',
		'google.local.md': '---\nrefreshToken: 12345\n---\n',
	});
	const booksFolder = await f.app('books', books);
	await f.folder(join(booksFolder, 'data'), {
		'books/dune.md': '---\ntitle: "Dune"\n---\n',
	});
	return f;
}

test('an app whose records all fit reports its counts and exits 0', async () => {
	const f = await setup();
	expect(await f.run('check', 'books')).toEqual({
		code: 0,
		stdout:
			'books\n  books  data/books/{slug}.md\n    1 file, none with problems\n',
		stderr: '',
	});
});

test('problems are counted by kind, most frequent first, then listed by file, and exit 1', async () => {
	const f = await setup();
	const result = await f.run('check', 'tasks');
	expect(result.code).toBe(1);
	expect(result.stderr).toBe('');
	expect(result.stdout).toBe(
		[
			'tasks',
			'  items  data/items/{id}.md',
			'    5 files, 4 with problems',
			'    2  due is not a day like 2026-11-12',
			'    1  its front matter is neither key: <JSON> lines nor YAML',
			'    1  title is missing',
			'    data/items/a.md',
			'      due: "next week" is not a day like 2026-11-12',
			'    data/items/b.md',
			'      due: "soon" is not a day like 2026-11-12',
			'    data/items/c.md',
			'      title is missing',
			'    data/items/d.md',
			'      its front matter is neither key: <JSON> lines nor YAML',
			'  notes  data/notes/{slug}.md',
			'    0 files',
			'  settings  data/settings.md',
			'    1 file, 1 with problems',
			'    1  goal is not a whole number',
			'    data/settings.md',
			'      goal: "lots" is not a whole number',
			'  google  data/google.local.md',
			'    1 file, 1 with problems',
			'    1  refreshToken is not text',
			'    data/google.local.md',
			'      refreshToken is not text',
			'',
		].join('\n'),
	);
	expect(result.stdout).not.toContain('12345');
});

test('--json keys each collection by app and name, with its counts, kinds, and records', async () => {
	const f = await setup();
	const result = await f.run('check', 'tasks', '--json');
	expect(result.code).toBe(1);
	expect(result.stdout).not.toContain('12345');
	expect(JSON.parse(result.stdout)).toEqual({
		apps: {
			tasks: {
				items: {
					path: 'data/items/{id}.md',
					files: 5,
					withProblems: 4,
					kinds: [
						{ kind: 'due is not a day like 2026-11-12', count: 2 },
						{
							kind: 'its front matter is neither key: <JSON> lines nor YAML',
							count: 1,
						},
						{ kind: 'title is missing', count: 1 },
					],
					records: [
						{
							path: 'data/items/a.md',
							problems: ['due: "next week" is not a day like 2026-11-12'],
						},
						{
							path: 'data/items/b.md',
							problems: ['due: "soon" is not a day like 2026-11-12'],
						},
						{ path: 'data/items/c.md', problems: ['title is missing'] },
						{
							path: 'data/items/d.md',
							problems: [
								'its front matter is neither key: <JSON> lines nor YAML',
							],
						},
					],
				},
				notes: {
					path: 'data/notes/{slug}.md',
					files: 0,
					withProblems: 0,
					kinds: [],
					records: [],
				},
				settings: {
					path: 'data/settings.md',
					files: 1,
					withProblems: 1,
					kinds: [{ kind: 'goal is not a whole number', count: 1 }],
					records: [
						{
							path: 'data/settings.md',
							problems: ['goal: "lots" is not a whole number'],
						},
					],
				},
				google: {
					path: 'data/google.local.md',
					files: 1,
					withProblems: 1,
					kinds: [{ kind: 'refreshToken is not text', count: 1 }],
					records: [
						{
							path: 'data/google.local.md',
							problems: ['refreshToken is not text'],
						},
					],
				},
			},
		},
		problems: [],
	});
});

test('with no app named, checks every app and lists one that does not load under its problems', async () => {
	const f = await setup();
	await f.app('broken', `throw new Error('import exploded');`);
	const result = await f.run('check', '--json');
	expect(result.code).toBe(1);
	const report = JSON.parse(result.stdout);
	expect(Object.keys(report.apps)).toEqual(['books', 'tasks']);
	expect(report.apps.books.books.withProblems).toBe(0);
	expect(report.apps.tasks.items.withProblems).toBe(4);
	expect(report.problems).toEqual([
		{
			entry: 'broken',
			folder: join(f.apps, 'broken'),
			problems: ['code/epicenter.ts: import exploded'],
		},
	]);
	const human = await f.run('check');
	expect(human.code).toBe(1);
	expect(human.stdout).toStartWith(
		'books\n  books  data/books/{slug}.md\n    1 file, none with problems\n\ntasks\n',
	);
	expect(human.stdout).toEndWith(
		`Problems:\n  broken\n    ${join(f.apps, 'broken')}\n    code/epicenter.ts: import exploded\n`,
	);
});

test('a named app that does not load or does not exist did not run, exit 2', async () => {
	const f = await setup();
	await f.app('broken', `throw new Error('import exploded');`);
	const broken = await f.run('check', 'broken', '--json');
	expect(broken.code).toBe(2);
	expect(JSON.parse(broken.stdout).error).toMatchObject({
		name: 'AppProblems',
		problems: ['code/epicenter.ts: import exploded'],
	});
	const unknown = await f.run('check', 'nope', '--json');
	expect(unknown.code).toBe(2);
	expect(JSON.parse(unknown.stdout).error.message).toBe('Unknown app "nope"');
});
