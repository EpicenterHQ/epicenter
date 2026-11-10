/**
 * New app tests cover template commits, name validation, and the backup
 * warning shown until an origin receives the app's branch.
 */
import { afterEach, expect, test } from 'bun:test';
import { mkdir, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { fixture, gitIn } from './runner.test-support.ts';

const roots: string[] = [];
afterEach(async () => {
	await Promise.all(
		roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
	);
});

test('new refuses duplicate names without regard to case and reserved words', async () => {
	const f = await fixture();
	roots.push(f.root);
	await mkdir(join(f.home, 'Reading'));
	for (const name of [
		'reading',
		'serve',
		'update',
		'init',
		'build',
		'Bad_Name',
	]) {
		const result = await f.run('new', name, '--json');
		expect(result.code).toBe(2);
		expect(JSON.parse(result.stdout).error.name).toBe('Usage');
	}
});

test('new commits its template and link is a valid app name', async () => {
	const f = await fixture();
	roots.push(f.root);
	const made = await f.run('new', 'garden');
	expect(made.code).toBe(0);
	const garden = join(f.home, 'garden');
	expect(made.stderr).toEndWith(
		`not backed up\nRun: git -C ${garden} remote add origin <url>, then epicenter sync garden\n`,
	);
	expect(await readFile(join(garden, '.gitignore'), 'utf8')).toBe(
		'node_modules/\n*.local\n*.local.*\n',
	);
	expect(await gitIn(garden, 'log', '--format=%s')).toBe('new garden');
	expect(await gitIn(garden, 'ls-files')).toBe('.gitignore\nepicenter.ts');
	expect(await gitIn(garden, 'status', '--porcelain')).toBe('');

	expect((await f.run('new', 'link')).code).toBe(0);
	expect(await gitIn(join(f.home, 'link'), 'log', '--format=%s')).toBe(
		'new link',
	);
});

test('listings distinguish no origin, an unpushed origin, and a pushed backup', async () => {
	const f = await fixture();
	roots.push(f.root);
	expect((await f.run('new', 'garden')).code).toBe(0);
	const garden = join(f.home, 'garden');
	const none = await f.run('garden');
	expect(none.stdout).toContain(
		`not backed up\nRun: git -C ${garden} remote add origin <url>, then epicenter sync garden`,
	);
	expect(JSON.parse((await f.run('--json')).stdout).apps[0].status).toEqual({
		pending: 0,
		backup: 'none',
	});
	expect((await f.run()).stdout).toContain(
		`(not backed up)\n\nRun: epicenter <app>\nRun: git -C ${garden} remote add origin <url>, then epicenter sync garden`,
	);

	const backup = join(f.root, 'backup.git');
	await gitIn(f.root, 'init', '-q', '--bare', backup);
	await gitIn(garden, 'remote', 'add', 'origin', backup);
	expect((await f.run('garden')).stdout).toContain(
		'never backed up\nRun: epicenter sync garden',
	);
	expect(JSON.parse((await f.run('garden', '--json')).stdout).status).toEqual({
		pending: 0,
		backup: 'never',
	});
	expect((await f.run()).stdout).toContain('(never backed up)');

	expect((await f.run('sync', 'garden')).code).toBe(0);
	expect(
		JSON.parse((await f.run('garden', '--json')).stdout),
	).not.toHaveProperty('status');
	expect((await f.run()).stdout).not.toContain('backed up');
});
