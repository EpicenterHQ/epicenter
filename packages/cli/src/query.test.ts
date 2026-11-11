/**
 * The real query command lists tables, binds SQL values, rereads files, and
 * returns one JSON value. Queries leave Git state and the app's lock alone.
 */
import { afterEach, expect, setDefaultTimeout, test } from 'bun:test';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { hold } from './lock.js';
import { fixture, gitIn } from './runner.test-support.js';

setDefaultTimeout(30_000);
const roots: string[] = [];
afterEach(async () => {
	await Promise.all(
		roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
	);
});
async function setup() {
	const f = await fixture();
	roots.push(f.root);
	const appPath = await f.app(
		'reading',
		`
const books = defineCollection({ path: 'books/{slug}.md', fields: { title: field.text(), finished: field.date({ optional: true }) } });
const local = defineCollection({ path: 'token.local.md', fields: {} });
export default defineApp({ description: 'Reading', collections: { books, local }, actions: { books: books.actions() } });`,
	);
	await mkdir(join(appPath, 'books'));
	await writeFile(join(appPath, 'books/dune.md'), '---\ntitle: "Dune"\n---\n');
	return { ...f, appPath };
}

test('query help explains its usage and appears in root help', async () => {
	const f = await setup();
	const help = await f.run('query', '--help');
	expect(help.code).toBe(0);
	expect(help.stdout).toContain(
		'epicenter query <app> [<sql>] [--params <json>]',
	);
	expect((await f.run('--help')).stdout).toContain('epicenter query <app>');
	const reserved = await f.run('new', 'query', '--json');
	expect(reserved.code).toBe(2);
	expect(JSON.parse(reserved.stdout).error.message).toContain(
		'is an epicenter command',
	);
});

test('table listings omit local collections and queries print rows as JSON or human output', async () => {
	const f = await setup();
	const human = await f.run('query', 'reading');
	expect(human.code).toBe(0);
	expect(human.stdout).toContain(
		'books  books/{slug}.md\n  path text, slug text, title text, finished text, body text, problems json, other json',
	);
	expect(human.stdout).not.toContain('token');
	const tables = await f.run('query', 'reading', '--json');
	expect(tables.code).toBe(0);
	expect(JSON.parse(tables.stdout)).toEqual([
		{
			table: 'books',
			path: 'books/{slug}.md',
			columns: [
				'path',
				'slug',
				'title',
				'finished',
				'body',
				'problems',
				'other',
			].map((name) => ({
				name,
				type: ['problems', 'other'].includes(name) ? 'json' : 'text',
			})),
		},
	]);
	const sql = 'select title from books where finished is null';
	expect(await f.run('query', 'reading', sql)).toEqual({
		code: 0,
		stdout: 'title: Dune\n',
		stderr: '',
	});
	expect(await f.run('query', 'reading', sql, '--json')).toEqual({
		code: 0,
		stdout: '[{"title":"Dune"}]\n',
		stderr: '',
	});
	for (const [condition, params] of [
		['?', '["Dune"]'],
		['$title', '{"title":"Dune"}'],
	]) {
		const result = await f.run(
			'query',
			'reading',
			`select title from books where title = ${condition}`,
			'--params',
			params as string,
			'--json',
		);
		expect(result).toEqual({
			code: 0,
			stdout: '[{"title":"Dune"}]\n',
			stderr: '',
		});
	}
	expect(
		(await f.run('query', 'reading', 'select title from books where 0')).stdout,
	).toBe('');
});

test('queries reread disk without taking the app lock or changing Git status or history', async () => {
	const f = await setup();
	const status = await gitIn(f.appPath, 'status', '--porcelain');
	const log = await gitIn(f.appPath, 'log', '--oneline');
	// An exclusive lock must not delay a query.
	const held = await hold(f.appPath, 0);
	expect(held).toBeDefined();
	try {
		expect(
			(await f.run('query', 'reading', 'select title from books')).code,
		).toBe(0);
		expect(await gitIn(f.appPath, 'status', '--porcelain')).toBe(status);
		expect(await gitIn(f.appPath, 'log', '--oneline')).toBe(log);
		await writeFile(
			join(f.appPath, 'books/dune.md'),
			'---\ntitle: "Changed"\n---\n',
		);
		const editedStatus = await gitIn(f.appPath, 'status', '--porcelain');
		expect(
			(await f.run('query', 'reading', 'select title from books', '--json'))
				.stdout,
		).toBe('[{"title":"Changed"}]\n');
		expect(await gitIn(f.appPath, 'status', '--porcelain')).toBe(editedStatus);
		expect(await gitIn(f.appPath, 'log', '--oneline')).toBe(log);
	} finally {
		held?.release();
	}
});

test('no-table apps say so and JSON errors are single objects with exit 2', async () => {
	const f = await setup();
	await f.app(
		'empty',
		`export default defineApp({ description: 'Empty', collections: {}, actions: {} });`,
	);
	await f.app('broken', 'export default { actions: {} };');
	expect((await f.run('query', 'empty')).stdout).toBe('empty has no tables\n');
	const cases: [string[], string][] = [
		[[], 'Usage'],
		[['unknown'], 'Usage'],
		[['reading', '--params', '[]'], 'Usage'],
		[['broken'], 'AppProblems'],
		[['reading', 'delete from books'], 'Refused'],
		[['reading', 'select from'], 'Usage'],
		[['reading', 'select ?', '--params', 'broken'], 'Usage'],
		[['reading', 'select ?', '--params', '[{}]'], 'Usage'],
		[['reading', 'select ?', '--params', 'null'], 'Usage'],
		[['reading', 'select ?', '--params', '1'], 'Usage'],
	];
	for (const [args, name] of cases) {
		const result = await f.run('query', ...args, '--json');
		expect(result.code).toBe(2);
		expect(result.stderr).toBe('');
		expect(result.stdout.trim().split('\n')).toHaveLength(1);
		const value = JSON.parse(result.stdout);
		expect(Object.keys(value)).toEqual(['error']);
		expect(value.error.name).toBe(name);
	}
});

test('refused SQL prints its message and help on stderr in plain output', async () => {
	const f = await setup();
	const result = await f.run('query', 'reading', 'delete from books');
	expect(result.code).toBe(2);
	expect(result.stdout).toBe('');
	expect(result.stderr).toContain(
		'A query only reads: use one SELECT, WITH, or VALUES statement',
	);
	expect(result.stderr).toContain('Run: epicenter query --help');
});
