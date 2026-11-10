import { afterEach, expect, test } from 'bun:test';
import { mkdir, rm } from 'node:fs/promises';
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
	expect((await f.run('new', 'garden')).code).toBe(0);
	const garden = join(f.home, 'garden');
	expect(await gitIn(garden, 'log', '--format=%s')).toBe('new garden');
	expect(await gitIn(garden, 'ls-files')).toBe('.gitignore\nepicenter.ts');
	expect(await gitIn(garden, 'status', '--porcelain')).toBe('');

	expect((await f.run('new', 'link')).code).toBe(0);
	expect(await gitIn(join(f.home, 'link'), 'log', '--format=%s')).toBe(
		'new link',
	);
});
