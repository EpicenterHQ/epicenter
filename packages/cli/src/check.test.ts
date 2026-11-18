/**
 * `epicenter check` Tests
 *
 * Runs the real command against a temporary Epicenter to verify which apps a
 * check reads and how it answers. What a data key's report
 * holds is in `check.data.test.ts`.
 *
 * Key behaviors:
 * - With no app named, every app is checked and one that does not load is
 *   listed under its problems without stopping the rest
 * - The report is the answer, `{ data, error: null }`, exit 0, whatever it
 *   finds
 * - A named app that does not load or does not exist did not run: `NotStarted`,
 *   exit 2
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
const data = defineData({ items: { fields: { title: field.text(), due: field.date({ optional: true }) } } });
export default defineApp({ description: 'Tasks', data, actions: {} });
`;

const books = `
const data = defineData({ books: { fields: { title: field.text() } } });
export default defineApp({ description: 'Books', data, actions: {} });
`;

async function setup() {
	const f = await fixture();
	roots.push(f.root);
	const tasksFolder = await f.app('tasks', tasks);
	await f.folder(join(tasksFolder, 'data'), {
		'items/a.md': '---\ntitle: "A"\ndue: "next week"\n---\n',
		'items/e.md': '---\ntitle: "E"\n---\n',
	});
	const booksFolder = await f.app('books', books);
	await f.folder(join(booksFolder, 'data'), {
		'books/dune.md': '---\ntitle: "Dune"\n---\n',
	});
	return f;
}

test('with no app named, checks every app and lists one that does not load under its problems', async () => {
	const f = await setup();
	await f.app('broken', `throw new Error('import exploded');`);
	const result = await f.run('check', '--json');
	expect(result.code).toBe(0);
	const { data: report, error } = JSON.parse(result.stdout);
	expect(error).toBeNull();
	expect(Object.keys(report.apps)).toEqual(['books', 'tasks']);
	expect(report.apps.books.books.withProblems).toBe(0);
	expect(report.apps.tasks.items.withProblems).toBe(1);
	expect(report.problems).toEqual([
		{
			entry: 'broken',
			folder: join(f.apps, 'broken'),
			problems: ['code/epicenter.ts: import exploded'],
		},
	]);
	const human = await f.run('check');
	expect(human.code).toBe(0);
	expect(human.stdout).toStartWith(
		'books\n  books  1 file, none with problems\n\ntasks\n',
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
	expect(JSON.parse(broken.stdout)).toEqual({
		data: null,
		error: {
			name: 'NotStarted',
			cause: 'app-problems',
			message: 'broken: code/epicenter.ts: import exploded',
			app: 'broken',
			problems: ['code/epicenter.ts: import exploded'],
			namespace: 'epicenter/action-error',
		},
	});
	const unknown = await f.run('check', 'nope', '--json');
	expect(unknown.code).toBe(2);
	expect(JSON.parse(unknown.stdout).error).toMatchObject({
		name: 'NotStarted',
		cause: 'usage',
		message: 'Unknown app "nope"',
		next: 'epicenter',
	});
});
