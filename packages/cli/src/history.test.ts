/**
 * `epicenter history` reads an app's snapshots and `epicenter undo` reverts
 * one, through the real command against real repositories. Undo must never
 * lose anything: every refusal leaves the folder's files and HEAD as they
 * were.
 */
import { afterEach, expect, setDefaultTimeout, test } from 'bun:test';
import { existsSync } from 'node:fs';
import { readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { hold } from './lock.ts';
import { fixture, gitIn } from './runner.test-support.ts';

// Each test runs the real command several times as separate processes.
setDefaultTimeout(60_000);

const roots: string[] = [];
afterEach(async () => {
	await Promise.all(
		roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
	);
});

/** Notes: an action that writes `data/log.md`. */
const notes = `
export default defineApp({ description: 'Notes', collections: {}, actions: {
	put: defineAction({ description: 'Write the log', input: { text: field.text() }, positional: ['text'], run: async ({ text }) => { await folder.write('data/log.md', text + '\\n'); return text; } }),
} });`;

async function setup() {
	const f = await fixture();
	roots.push(f.root);
	const app = await f.app('notes', notes);
	const data = join(app, 'data');
	const head = () => gitIn(data, 'rev-parse', 'HEAD');
	const subject = (rev = 'HEAD') =>
		gitIn(data, 'log', '-1', '--format=%s', rev);
	const log = async () =>
		existsSync(join(app, 'data/log.md'))
			? await readFile(join(app, 'data/log.md'), 'utf8')
			: undefined;
	/** Commit data files by hand with `message`, as a snapshot would name them. */
	async function commit(files: Record<string, string>, message: string) {
		for (const [path, text] of Object.entries(files))
			await writeFile(join(app, path), text);
		await gitIn(data, 'add', '-A');
		await gitIn(data, 'commit', '-q', '-m', message);
		return head();
	}
	async function codeCommit(files: Record<string, string>, message: string) {
		for (const [path, text] of Object.entries(files))
			await writeFile(join(app, path), text);
		await gitIn(app, 'add', '-A');
		await gitIn(app, 'commit', '-q', '-m', message);
		return gitIn(app, 'rev-parse', 'HEAD');
	}
	/** HEAD, the folder's status, and `data/log.md`: what a refusal must leave alone. */
	const state = async () => ({
		head: await head(),
		status: await gitIn(data, 'status', '--porcelain'),
		codeStatus: await gitIn(app, 'status', '--porcelain'),
		log: await log(),
		reverting: existsSync(
			join(data, await gitIn(data, 'rev-parse', '--git-path', 'REVERT_HEAD')),
		),
	});
	return { ...f, app, data, head, subject, log, commit, codeCommit, state };
}

test('history lists calls, an outside change, and an undo, newest first', async () => {
	const f = await setup();
	expect((await f.run('notes', 'put', 'one')).code).toBe(0);
	const one = await f.head();
	const outside = await f.commit(
		{ 'data/outside.md': 'by hand\n' },
		'notes: changed outside epicenter',
	);
	const two = await f.commit({ 'data/log.md': 'two\n' }, 'notes: put two');
	expect((await f.run('undo', 'notes')).code).toBe(0);
	const undo = await f.head();
	const codeHead = await gitIn(f.app, 'rev-parse', 'HEAD');

	const listed = await f.run('history', 'notes', '--json');
	expect(listed.code).toBe(0);
	const snapshots = JSON.parse(listed.stdout);
	expect(
		snapshots.filter(
			(item: { repository: string }) => item.repository === 'data',
		),
	).toEqual([
		{
			repository: 'data',
			commit: undo,
			date: expect.any(String),
			subject: 'notes: undid notes: put two',
			changed: ['data/log.md'],
			code: codeHead,
			undid: two,
		},
		{
			repository: 'data',
			commit: two,
			date: expect.any(String),
			subject: 'notes: put two',
			changed: ['data/log.md'],
		},
		{
			repository: 'data',
			commit: outside,
			date: expect.any(String),
			subject: 'notes: changed outside epicenter',
			changed: ['data/outside.md'],
		},
		{
			repository: 'data',
			commit: one,
			date: expect.any(String),
			subject: 'notes: put one',
			changed: ['data/log.md'],
			code: codeHead,
		},
		{
			repository: 'data',
			commit: expect.any(String),
			date: expect.any(String),
			subject: 'notes: start its data',
			changed: ['data/.gitignore'],
			code: codeHead,
		},
	]);
	expect(
		snapshots.find(
			(item: { repository: string }) => item.repository === 'code',
		),
	).toMatchObject({
		commit: codeHead,
		subject: 'initial',
		changed: ['.gitignore', 'epicenter.ts'],
	});
	expect(snapshots[0].date).toMatch(/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d[+-Z]/);

	const human = await f.run('history', 'notes');
	expect(human.code).toBe(0);
	expect(human.stdout).toMatch(/ {2}data {2}undid notes: put two/);
	expect(human.stdout).toMatch(/ {2}code {2}initial/);
	expect(human.stdout).toContain('data/outside.md');
	expect(human.stdout).not.toContain('This reverts commit');

	const limited = await f.run('history', 'notes', '--limit', '2', '--json');
	expect(JSON.parse(limited.stdout)).toHaveLength(2);
	// Any positive whole number is a limit; one past what Git reads is every commit.
	const every = await f.run(
		'history',
		'notes',
		'--limit=99999999999',
		'--json',
	);
	expect(JSON.parse(every.stdout)).toHaveLength(6);
	expect((await f.run('history', 'notes', '--limit', '0')).code).toBe(2);
	expect((await f.run('history', 'nothing')).code).toBe(2);
});

test("history takes each commit's paths from Git, whatever they hold, and a merge's from its first parent", async () => {
	const f = await setup();
	await f.codeCommit(
		{ 'a,b.md': 'comma\n', 'line\nbreak.md': 'newline\n' },
		'any message at all',
	);
	const main = await gitIn(f.app, 'symbolic-ref', '--short', 'HEAD');
	await gitIn(f.app, 'checkout', '-q', '-b', 'starter');
	await f.codeCommit({ 'starter.md': 's\n' }, 'starter change');
	await gitIn(f.app, 'checkout', '-q', main);
	await gitIn(f.app, 'merge', '-q', '--no-ff', '-m', 'merged', 'starter');
	const listed = JSON.parse((await f.run('history', 'notes', '--json')).stdout);
	expect(listed.map((one: { changed: string[] }) => one.changed)).toEqual([
		['starter.md'],
		['a,b.md', 'line\nbreak.md'],
		['.gitignore', 'epicenter.ts'],
	]);
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
	expect(await gitIn(f.data, 'log', '-1', '--format=%b')).toContain(
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
});

test('undoing a commit already undone changes nothing, so it is refused', async () => {
	const f = await setup();
	expect((await f.run('notes', 'put', 'one')).code).toBe(0);
	expect((await f.run('notes', 'put', 'two')).code).toBe(0);
	const two = await f.head();
	expect((await f.run('undo', 'notes')).code).toBe(0);
	const before = await f.state();
	const again = await f.run('undo', 'notes', two, '--json');
	expect(again.code).toBe(2);
	expect(JSON.parse(again.stdout).error).toMatchObject({
		name: 'Refused',
		message: expect.stringContaining(
			'changes nothing now, since later changes already undid it',
		),
	});
	expect(await f.state()).toEqual(before);
});

test('undo reports code commits made after the data it reverts', async () => {
	const f = await setup();
	expect((await f.run('notes', 'put', 'one')).code).toBe(0);
	const code = await f.codeCommit(
		{ 'README.md': 'New instructions\n' },
		'explain the records',
	);
	const undone = await f.run('undo', 'notes', '--json');
	expect(undone.code).toBe(0);
	expect(JSON.parse(undone.stdout).codeSince).toEqual([
		{ commit: code, subject: 'explain the records' },
	]);
});

test('undo refuses a code commit and names the Git revert command', async () => {
	const f = await setup();
	expect((await f.run('notes', 'put', 'one')).code).toBe(0);
	const code = await f.codeCommit(
		{ 'README.md': 'New instructions\n' },
		'explain the records',
	);
	const before = await f.state();
	const refused = await f.run('undo', 'notes', code, '--json');
	expect(refused.code).toBe(2);
	expect(JSON.parse(refused.stdout).error).toEqual({
		name: 'Refused',
		message: expect.stringContaining("is a commit in notes's code"),
		next: `git -C ${f.app} revert ${code}`,
	});
	expect(await f.state()).toEqual(before);
});

test('undo refuses while Git is in the middle of a revert, changing nothing', async () => {
	const f = await setup();
	expect((await f.run('notes', 'put', 'one')).code).toBe(0);
	const reverting = await gitIn(
		f.data,
		'rev-parse',
		'--git-path',
		'REVERT_HEAD',
	);
	await writeFile(join(f.data, reverting), `${await f.head()}\n`);
	const before = await f.state();
	const refused = await f.run('undo', 'notes', '--json');
	expect(refused.code).toBe(2);
	expect(JSON.parse(refused.stdout).error).toEqual({
		name: 'Refused',
		message: expect.stringContaining(
			'nothing was undone, since what is pending could not be snapshotted first: notes/data is in the middle of a merge, rebase, revert, or cherry-pick',
		),
		next: `git -C ${f.data} status`,
	});
	expect(await f.state()).toEqual(before);
});

test('undo snapshots pending changes first, so undoing them loses nothing', async () => {
	const f = await setup();
	expect((await f.run('notes', 'put', 'one')).code).toBe(0);
	await writeFile(join(f.app, 'data/log.md'), 'edited by hand\n');

	const undone = await f.run('undo', 'notes', '--json');
	expect(undone.code).toBe(0);
	const { undid } = JSON.parse(undone.stdout);
	expect(undid).toBe(await gitIn(f.data, 'rev-parse', 'HEAD~1'));
	expect(await gitIn(f.data, 'show', `${undid}:log.md`)).toBe('edited by hand');
	expect(await f.subject(undid)).toStartWith('notes: ');
	expect(await f.log()).toBe('one\n');
	expect(await gitIn(f.data, 'status', '--porcelain')).toBe('');
});

test("undo waits while a call holds the app's lock, then snapshots and reverts in one hold", async () => {
	const f = await setup();
	expect((await f.run('notes', 'put', 'one')).code).toBe(0);
	await writeFile(join(f.app, 'data/log.md'), 'edited by hand\n');
	// As a call writing the app would, from its first write to its commit.
	const call = await hold(f.app, 0);
	expect(call).toBeDefined();
	const started = Date.now();
	const undoing = f.run('undo', 'notes');
	await Bun.sleep(300);
	expect(await f.subject()).toBe('notes: put one');
	call?.release();
	expect((await undoing).code).toBe(0);
	expect(Date.now() - started).toBeGreaterThanOrEqual(300);
	expect(await f.subject()).toStartWith('notes: undid ');
	expect(await f.log()).toBe('one\n');
});

test("undo of a merge stops where Git refuses it, and a commit not in the app's history is refused, changing nothing", async () => {
	const f = await setup();
	expect((await f.run('notes', 'put', 'one')).code).toBe(0);
	const main = await gitIn(f.data, 'symbolic-ref', '--short', 'HEAD');
	await gitIn(f.data, 'checkout', '-q', '-b', 'starter', 'HEAD~1');
	const elsewhere = await f.commit(
		{ 'data/starter.md': 's\n' },
		'starter change',
	);
	await gitIn(f.data, 'checkout', '-q', main);
	await gitIn(
		f.data,
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
	expect(latest.stderr).toContain('notes: could not undo');
	expect(latest.stderr).toContain('is a merge but no -m option was given');
	expect(latest.stderr).toContain('the folder is as it was');
	expect(latest.stderr).toContain(`Run: git -C ${f.data} revert -m 1 ${merge}`);
	expect(await f.state()).toEqual(before);

	const named = await f.run('undo', 'notes', merge, '--json');
	expect(named.code).toBe(2);
	expect(JSON.parse(named.stdout).error.message).toContain(
		'is a merge but no -m option was given',
	);
	expect(JSON.parse(named.stdout).error.next).toBe(
		`git -C ${f.data} revert -m 1 ${merge}`,
	);
	expect(await f.state()).toEqual(before);

	await gitIn(f.data, 'branch', 'other', elsewhere);
	await gitIn(f.data, 'checkout', '-q', '-b', 'side', 'HEAD~1');
	const side = await f.commit({ 'data/side.md': 's\n' }, 'notes: side');
	await gitIn(f.data, 'checkout', '-q', main);
	for (const missing of [side, 'abc1234', 'no-such-commit']) {
		const refused = await f.run('undo', 'notes', missing);
		expect(refused.code).toBe(2);
		expect(refused.stderr).toContain(
			`${missing} is not a commit in notes's history`,
		);
		expect(await f.state()).toEqual(before);
	}

	// An older snapshot below the merge can still be named.
	const one = (await gitIn(f.data, 'log', '--first-parent', '--format=%H %s'))
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
	await writeFile(join(f.data, 'scratch.local'), 'never committed\n');
	const before = await f.state();

	const conflicted = await f.run('undo', 'notes', one, '--json');
	expect(conflicted.code).toBe(2);
	const { error } = JSON.parse(conflicted.stdout);
	expect(error).toMatchObject({ name: 'Refused' });
	expect(error.message).toContain('conflicts with later changes to log.md');
	expect(error.message).toContain('the folder is as it was');
	expect(await f.state()).toEqual(before);
	expect(before.log).toBe('two\n');
	expect(await readFile(join(f.data, 'scratch.local'), 'utf8')).toBe(
		'never committed\n',
	);
});

test('undo never pushes; sync backs up the undo', async () => {
	const f = await setup();
	const backup = join(f.root, 'backup.git');
	await gitIn(f.root, 'init', '-q', '--bare', backup);
	expect((await f.run('notes', 'put', 'one')).code).toBe(0);
	await gitIn(f.data, 'remote', 'add', 'origin', backup);
	const branch = await gitIn(f.data, 'symbolic-ref', '--short', 'HEAD');
	expect((await f.run('sync', 'notes')).code).toBe(0);
	const pushed = await gitIn(backup, 'rev-parse', branch);

	const undone = await f.run('undo', 'notes');
	expect(undone).toMatchObject({ code: 0, stderr: '' });
	expect(await gitIn(backup, 'rev-parse', branch)).toBe(pushed);

	expect((await f.run('sync', 'notes')).stdout).toContain(
		'notes/data: nothing to commit; pushed; 0 ahead of origin\n',
	);
	expect(await gitIn(backup, 'rev-parse', branch)).toBe(await f.head());
});
