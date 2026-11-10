/**
 * `epicenter history` reads an app's snapshots and `epicenter undo` reverts
 * one, through the real command against real repositories. Undo must never
 * lose anything: every refusal leaves the folder's files and HEAD as they
 * were.
 */
import { afterEach, expect, setDefaultTimeout, test } from 'bun:test';
import { existsSync } from 'node:fs';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fixture, gitIn } from './runner.test-support.ts';

// Each test runs the real command several times as separate processes.
setDefaultTimeout(60_000);

const roots: string[] = [];
afterEach(async () => {
	await Promise.all(
		roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
	);
});

/** Notes: an action that writes `log.md`, and a collection of pages. */
const notes = `
const pages = defineCollection({ path: 'pages/{slug}.md', fields: { title: field.text(), done: field.boolean() } });
const todos = defineCollection({ path: 'todos/{id}.md', fields: { title: field.text() } });
export default defineApp({ description: 'Notes', collections: { pages, todos }, actions: {
	pages: pages.actions(),
	todos: todos.actions(),
	put: defineAction({ description: 'Write the log', input: { text: field.text() }, positional: ['text'], run: async ({ text }) => { await folder.write('log.md', text + '\\n'); return text; } }),
} });`;

async function setup() {
	const f = await fixture();
	roots.push(f.root);
	const app = await f.app('notes', notes);
	const head = () => gitIn(app, 'rev-parse', 'HEAD');
	const subject = (rev = 'HEAD') => gitIn(app, 'log', '-1', '--format=%s', rev);
	const log = async () =>
		existsSync(join(app, 'log.md'))
			? await readFile(join(app, 'log.md'), 'utf8')
			: undefined;
	/** Commit `files` by hand with `message`, as a snapshot would name them. */
	async function commit(files: Record<string, string>, message: string) {
		for (const [path, text] of Object.entries(files))
			await writeFile(join(app, path), text);
		await gitIn(app, 'add', '-A');
		await gitIn(app, 'commit', '-q', '-m', message);
		return head();
	}
	/** HEAD, the folder's status, and `log.md`: what a refusal must leave alone. */
	const state = async () => ({
		head: await head(),
		status: await gitIn(app, 'status', '--porcelain'),
		log: await log(),
		reverting: existsSync(
			join(app, await gitIn(app, 'rev-parse', '--git-path', 'REVERT_HEAD')),
		),
	});
	return { ...f, app, head, subject, log, commit, state };
}

test('history lists calls, an outside change, and an undo, newest first', async () => {
	const f = await setup();
	expect((await f.run('notes', 'put', 'one')).code).toBe(0);
	const one = await f.head();
	const outside = await f.commit(
		{ 'outside.md': 'by hand\n' },
		'notes: changed outside epicenter\n\nChanged: outside.md',
	);
	const two = await f.commit(
		{ 'log.md': 'two\n', 'extra.md': 'x\n' },
		'notes: put two\n\nAlso changed: extra.md',
	);
	expect((await f.run('undo', 'notes')).code).toBe(0);
	const undo = await f.head();

	const listed = await f.run('history', 'notes', '--json');
	expect(listed.code).toBe(0);
	const snapshots = JSON.parse(listed.stdout);
	expect(snapshots).toEqual([
		{
			commit: undo,
			date: expect.any(String),
			subject: 'notes: undid notes: put two',
			also: [],
			undid: two,
		},
		{
			commit: two,
			date: expect.any(String),
			subject: 'notes: put two',
			also: ['extra.md'],
		},
		{
			commit: outside,
			date: expect.any(String),
			subject: 'notes: changed outside epicenter',
			also: ['outside.md'],
		},
		{
			commit: one,
			date: expect.any(String),
			subject: 'notes: put one',
			also: [],
		},
		{
			commit: expect.any(String),
			date: expect.any(String),
			subject: 'initial',
			also: [],
		},
	]);
	expect(snapshots[0].date).toMatch(/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d[+-Z]/);

	const human = await f.run('history', 'notes');
	expect(human.code).toBe(0);
	const lines = human.stdout.trimEnd().split('\n');
	expect(lines[0]).toMatch(
		new RegExp(
			`^${undo.slice(0, 7)} {2}\\d{4}-\\d\\d-\\d\\d \\d\\d:\\d\\d {2}undid notes: put two$`,
		),
	);
	expect(lines[1]).toMatch(/ {2}notes: put two$/);
	expect(lines[2]).toBe(`${' '.repeat(27)}Also changed: extra.md`);
	expect(lines[3]).toMatch(/ {2}notes: changed outside epicenter$/);
	expect(lines[4]).toBe(`${' '.repeat(27)}Changed: outside.md`);
	expect(human.stdout).not.toContain('This reverts commit');

	const limited = await f.run('history', 'notes', '--limit', '2', '--json');
	expect(JSON.parse(limited.stdout)).toHaveLength(2);
	expect((await f.run('history', 'notes', '--limit', '0')).code).toBe(2);
	expect((await f.run('history', 'nothing')).code).toBe(2);
});

test('undo twice goes back twice, and undoing an undo redoes it', async () => {
	const f = await setup();
	expect((await f.run('notes', 'put', 'one')).code).toBe(0);
	expect((await f.run('notes', 'put', 'two')).code).toBe(0);
	expect(await f.log()).toBe('two\n');

	const first = await f.run('undo', 'notes');
	expect(first.code).toBe(0);
	expect(first.stdout).toBe('undid notes: put two\n');
	expect(await f.log()).toBe('one\n');
	expect(await f.subject()).toBe('notes: undid notes: put two');

	const second = await f.run('undo', 'notes', '--json');
	expect(second.code).toBe(0);
	const { undid, commit } = JSON.parse(second.stdout);
	expect(await f.subject(undid)).toBe('notes: put one');
	expect(commit).toBe(await f.head());
	expect(await f.log()).toBeUndefined();
	expect(await gitIn(f.app, 'log', '-1', '--format=%b')).toBe(
		`This reverts commit ${undid}.`,
	);

	// Only the first commit is left, and it is not a snapshot.
	const before = await f.state();
	const nothing = await f.run('undo', 'notes');
	expect(nothing.code).toBe(2);
	expect(nothing.stderr).toContain('notes has no snapshot to undo');
	expect(await f.state()).toEqual(before);

	// Undo the second undo: put one comes back.
	const redo = await f.run('undo', 'notes', commit.slice(0, 7));
	expect(redo.code).toBe(0);
	expect(redo.stdout).toBe('undid notes: undid notes: put one\n');
	expect(await f.log()).toBe('one\n');

	// The undo it redid no longer hides put one, so undo reaches it again.
	expect((await f.run('undo', 'notes')).stdout).toBe('undid notes: put one\n');
	expect(await f.log()).toBeUndefined();

	// A commit already undone is refused, naming the undo that undid it.
	const two = (await gitIn(f.app, 'log', '--format=%H %s'))
		.split('\n')
		.find((line) => line.slice(41) === 'notes: put two')
		?.split(' ')[0] as string;
	const again = await f.run('undo', 'notes', two, '--json');
	expect(again.code).toBe(2);
	expect(JSON.parse(again.stdout).error).toMatchObject({
		name: 'Refused',
		message: expect.stringContaining('is already undone by'),
	});
});

test('undo snapshots pending changes first, so undoing them loses nothing', async () => {
	const f = await setup();
	expect((await f.run('notes', 'put', 'one')).code).toBe(0);
	await writeFile(join(f.app, 'log.md'), 'edited by hand\n');

	const undone = await f.run('undo', 'notes', '--json');
	expect(undone.code).toBe(0);
	const { undid } = JSON.parse(undone.stdout);
	expect(undid).toBe(await gitIn(f.app, 'rev-parse', 'HEAD~1'));
	expect(await gitIn(f.app, 'show', `${undid}:log.md`)).toBe('edited by hand');
	expect(await f.subject(undid)).toStartWith('notes: ');
	expect(await f.log()).toBe('one\n');
	expect(await gitIn(f.app, 'status', '--porcelain')).toBe('');
});

test("undo refuses a merge, and a commit not in the app's history, changing nothing", async () => {
	const f = await setup();
	expect((await f.run('notes', 'put', 'one')).code).toBe(0);
	const main = await gitIn(f.app, 'symbolic-ref', '--short', 'HEAD');
	await gitIn(f.app, 'checkout', '-q', '-b', 'starter', 'HEAD~1');
	const elsewhere = await f.commit({ 'starter.md': 's\n' }, 'starter change');
	await gitIn(f.app, 'checkout', '-q', main);
	await gitIn(
		f.app,
		'merge',
		'-q',
		'--no-ff',
		'-m',
		'notes: update from upstream',
		'starter',
	);
	const merge = await f.head();
	const before = await f.state();

	const latest = await f.run('undo', 'notes');
	expect(latest.code).toBe(2);
	expect(latest.stderr).toContain('is a merge');
	expect(await f.state()).toEqual(before);

	const named = await f.run('undo', 'notes', merge, '--json');
	expect(named.code).toBe(2);
	expect(JSON.parse(named.stdout).error.message).toContain(
		'undo does not undo a merge',
	);
	expect(await f.state()).toEqual(before);

	await gitIn(f.app, 'branch', 'other', elsewhere);
	await gitIn(f.app, 'checkout', '-q', '-b', 'side', 'HEAD~1');
	const side = await f.commit({ 'side.md': 's\n' }, 'notes: side');
	await gitIn(f.app, 'checkout', '-q', main);
	for (const missing of [side, 'abc1234', 'no-such-commit']) {
		const refused = await f.run('undo', 'notes', missing);
		expect(refused.code).toBe(2);
		expect(refused.stderr).toContain(
			`${missing} is not a commit in notes's history`,
		);
		expect(await f.state()).toEqual(before);
	}

	// An older snapshot below the merge can still be named.
	const one = (await gitIn(f.app, 'log', '--first-parent', '--format=%H %s'))
		.split('\n')
		.find((line) => line.slice(41) === 'notes: put one')
		?.split(' ')[0] as string;
	expect((await f.run('undo', 'notes', one)).code).toBe(0);
	expect(await f.log()).toBeUndefined();
});

test('undo refuses a revert that conflicts, and leaves the folder as it was', async () => {
	const f = await setup();
	expect((await f.run('notes', 'put', 'one')).code).toBe(0);
	const one = await f.head();
	expect((await f.run('notes', 'put', 'two')).code).toBe(0);
	await writeFile(join(f.app, 'scratch.local'), 'never committed\n');
	const before = await f.state();

	const conflicted = await f.run('undo', 'notes', one, '--json');
	expect(conflicted.code).toBe(2);
	const { error } = JSON.parse(conflicted.stdout);
	expect(error).toMatchObject({ name: 'Refused' });
	expect(error.message).toContain('conflicts with later changes to log.md');
	expect(error.message).toContain('the folder is as it was');
	expect(await f.state()).toEqual(before);
	expect(before.log).toBe('two\n');
	expect(await readFile(join(f.app, 'scratch.local'), 'utf8')).toBe(
		'never committed\n',
	);
});

test('a file reads as Markdown and rows as lines, while --json is unchanged', async () => {
	const f = await setup();
	await mkdir(join(f.app, 'pages'));
	await writeFile(
		join(f.app, 'pages', 'a.md'),
		'---\ntitle: "Alpha"\ndone: "yes"\ncolor: "red"\n---\nThe body.\n',
	);
	await writeFile(
		join(f.app, 'pages', 'b.md'),
		'---\ntitle: "Beta"\ndone: true\n---\n',
	);

	const got = await f.run('notes', 'pages', 'get', 'pages/a.md');
	expect(got.code).toBe(0);
	expect(got.stdout).toBe(
		'---\nslug: "a"\ntitle: "Alpha"\ndone: false\n# other: done: "yes"\n# other: color: "red"\n---\nThe body.\n',
	);
	expect(got.stderr).toBe(`! done: "yes" is not true or false\n`);

	const listed = await f.run('notes', 'pages', 'list');
	expect(listed.code).toBe(0);
	const rows = listed.stdout.split('\n');
	expect(rows[0]).toBe(
		'pages/a.md  slug: "a"  title: "Alpha"  done: false  problems: ["done: \\"yes\\" is not true or false"]',
	);
	expect(rows[1]).toBe('pages/b.md  slug: "b"  title: "Beta"  done: true');
	expect(rows).toHaveLength(3);

	const empty = await f.run('notes', 'todos', 'list');
	expect(empty).toMatchObject({ code: 0, stdout: '' });

	const json = await f.run('notes', 'pages', 'get', 'pages/b.md', '--json');
	expect(JSON.parse(json.stdout)).toEqual({
		returned: {
			path: 'pages/b.md',
			slug: 'b',
			title: 'Beta',
			done: true,
			body: '',
		},
	});
	expect(
		JSON.parse((await f.run('notes', 'todos', 'list', '--json')).stdout),
	).toEqual({ returned: [] });
});

test('undo pushes to origin as sync does; a push that fails is said, not undone', async () => {
	const f = await setup();
	const backup = join(f.root, 'backup.git');
	await gitIn(f.root, 'init', '-q', '--bare', backup);
	await gitIn(f.app, 'remote', 'add', 'origin', backup);
	const branch = await gitIn(f.app, 'symbolic-ref', '--short', 'HEAD');
	expect((await f.run('notes', 'put', 'one')).code).toBe(0);
	expect((await f.run('notes', 'put', 'two')).code).toBe(0);

	const pushed = await f.run('undo', 'notes');
	expect(pushed).toMatchObject({ code: 0, stderr: '' });
	expect(await gitIn(backup, 'rev-parse', branch)).toBe(await f.head());

	await gitIn(f.app, 'remote', 'set-url', 'origin', join(f.root, 'gone.git'));
	const unpushed = await f.run('undo', 'notes');
	expect(unpushed.code).toBe(0);
	expect(unpushed.stdout).toBe('undid notes: put one\n');
	expect(unpushed.stderr).toContain('notes: not pushed: ');
	expect(unpushed.stderr).toEndWith(
		`Run: git -C ${f.app} push origin HEAD:${branch}\n`,
	);
	expect(await f.log()).toBeUndefined();
});
