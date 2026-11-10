import { afterEach, expect, test } from 'bun:test';
import { existsSync } from 'node:fs';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { declarationOf, fixture, gitIn } from './runner.test-support.ts';

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
	for (const name of ['reading', 'serve', 'update', 'link', 'Bad_Name']) {
		const result = await f.run('new', name, '--json');
		expect(result.code).toBe(2);
		expect(JSON.parse(result.stdout).error.name).toBe('Usage');
	}
});

test('new commits its template, and link commits nothing in a repository it links', async () => {
	const f = await fixture();
	roots.push(f.root);
	expect((await f.run('new', 'garden')).code).toBe(0);
	const garden = join(f.home, 'garden');
	expect(await gitIn(garden, 'log', '--format=%s')).toBe('new garden');
	expect(await gitIn(garden, 'ls-files')).toBe('.gitignore\nepicenter.json');
	expect(await gitIn(garden, 'status', '--porcelain')).toBe('');

	const folder = join(f.root, 'kept');
	await mkdir(folder);
	await writeFile(join(folder, 'epicenter.json'), declarationOf('kept'));
	await gitIn(folder, 'init', '-q');
	await gitIn(folder, 'add', 'epicenter.json');
	await gitIn(
		folder,
		'-c',
		'user.name=t',
		'-c',
		'user.email=t@t',
		'commit',
		'-qm',
		'start',
	);
	const linked = await f.run('link', folder, '--json');
	expect(linked.code).toBe(0);
	expect(existsSync(join(folder, '.gitignore'))).toBe(false);
	expect(await gitIn(folder, 'log', '--format=%s')).toBe('start');
});
