import { afterEach, expect, test } from 'bun:test';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
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
	for (const name of ['reading', 'serve', 'Bad_Name']) {
		const result = await f.run('new', name, '--json');
		expect(result.code).toBe(2);
		expect(JSON.parse(result.stdout).error.name).toBe('Usage');
	}
});

test('add adopts a folder that is already a repository, as new and --init do', async () => {
	const f = await fixture();
	roots.push(f.root);
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
	const added = await f.run('add', folder, '--json');
	expect(added.code).toBe(0);
	expect(await readFile(join(folder, '.gitignore'), 'utf8')).toContain(
		'.cache/',
	);
	expect(await gitIn(folder, 'log', '-1', '--format=%s')).toBe('add kept');
	expect(await gitIn(folder, 'status', '--porcelain')).toBe('');
});
