/**
 * New app tests cover both initial repositories, name validation, and the
 * backup status shown until origins receive the app's branches.
 */
import { afterEach, expect, test } from 'bun:test';
import { mkdir, readFile, realpath, rm } from 'node:fs/promises';
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
	await mkdir(join(f.apps, 'Reading'));
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
	const garden = join(f.apps, 'garden');
	expect(made.stderr).toBe(
		`Run: epicenter garden\nnot backed up\nRun: git -C ${garden} remote add origin <url> and git -C ${garden}/data remote add origin <url>, each a private repository, then epicenter sync garden\n`,
	);
	expect(await readFile(join(garden, '.gitignore'), 'utf8')).toBe(
		'data/\nnode_modules/\n',
	);
	expect(await readFile(join(garden, 'data', '.gitignore'), 'utf8')).toBe(
		'*.local\n*.local.*\n',
	);
	expect(await gitIn(garden, 'log', '--format=%s')).toBe('new garden');
	expect(await gitIn(join(garden, 'data'), 'log', '--format=%s')).toBe(
		'garden: start its data',
	);
	expect(await gitIn(join(garden, 'data'), 'ls-files')).toBe('.gitignore');
	expect(await gitIn(garden, 'ls-files')).toBe(
		'.gitignore\nepicenter.ts\npackage.json',
	);
	expect(await gitIn(garden, 'status', '--porcelain')).toBe('');
	expect(await realpath(join(garden, 'node_modules/@epicenter/app'))).toBe(
		await realpath(join(import.meta.dir, '../../app')),
	);

	expect((await f.run('new', 'link')).code).toBe(0);
	expect(await gitIn(join(f.apps, 'link'), 'log', '--format=%s')).toBe(
		'new link',
	);
});

test('listings distinguish no origin, an origin never pushed to, and a pushed backup', async () => {
	const f = await fixture();
	roots.push(f.root);
	expect((await f.run('new', 'garden')).code).toBe(0);
	const garden = join(f.apps, 'garden');
	expect((await f.run('garden')).stdout).toContain(
		`data: not backed up\nRun: git -C ${garden} remote add origin <url> and git -C ${garden}/data remote add origin <url>, then epicenter sync garden`,
	);
	expect(JSON.parse((await f.run('--json')).stdout).apps[0].status).toEqual({
		code: { pending: 0, backup: 'none' },
		data: { pending: 0, backup: 'none' },
	});
	expect((await f.run()).stdout).toContain(
		`(code: not backed up; data: not backed up)\n\nRun: epicenter <app>\nRun: git -C ${garden} remote add origin <url> and git -C ${garden}/data remote add origin <url>, then epicenter sync garden`,
	);

	const backup = join(f.root, 'backup.git');
	await gitIn(f.root, 'init', '-q', '--bare', backup);
	await gitIn(garden, 'remote', 'add', 'origin', backup);
	expect((await f.run('garden')).stdout).toContain('code: never backed up');
	expect(JSON.parse((await f.run('garden', '--json')).stdout).status).toEqual({
		code: { pending: 0, backup: 'never' },
		data: { pending: 0, backup: 'none' },
	});
	expect((await f.run()).stdout).toContain('code: never backed up');

	expect((await f.run('sync', 'garden')).code).toBe(0);
	expect(JSON.parse((await f.run('garden', '--json')).stdout)).toHaveProperty(
		'status.data.backup',
		'none',
	);
	expect((await f.run()).stdout).toContain('data: not backed up');
});
