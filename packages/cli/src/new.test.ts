import { afterEach, expect, test } from 'bun:test';
import { mkdir, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { checkedGit } from './git.ts';
import { fixture } from './runner.test-support.ts';

const roots: string[] = [];
afterEach(async () => {
	await Promise.all(
		roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
	);
});

test('new creates the starter files and one initial commit', async () => {
	const f = await fixture();
	roots.push(f.root);
	await rm(f.home, { recursive: true });
	const result = await f.run('new', 'notes', '--json');
	expect(result.code).toBe(0);
	expect(JSON.parse(result.stdout)).toEqual({
		name: 'notes',
		folder: join(f.home, 'notes'),
		installed: false,
	});
	const folder = join(f.home, 'notes');
	expect(await readFile(join(folder, '.gitignore'), 'utf8')).toBe(
		'node_modules/\n.cache/\nepicenter.d.json.ts\n',
	);
	expect(
		JSON.parse(await readFile(join(folder, 'epicenter.json'), 'utf8')),
	).toEqual({
		$schema: 'https://epicenter.so/epicenter.schema.json',
		name: 'notes',
		description: 'Describe notes',
	});
	expect(
		JSON.parse(await readFile(join(folder, 'package.json'), 'utf8')),
	).toMatchObject({
		name: 'notes',
		dependencies: { '@epicenter/app': 'link:@epicenter/app' },
	});
	expect(await readFile(join(folder, 'epicenter.ts'), 'utf8')).toContain(
		"run: ({ who }) => `Hello, ${who ?? 'you'}`",
	);
	expect(
		(await checkedGit(folder, 'log', '-1', '--format=%s')).toString().trim(),
	).toBe('new notes');
	expect(
		(await checkedGit(folder, 'rev-list', '--count', 'HEAD')).toString().trim(),
	).toBe('1');
	expect((await checkedGit(folder, 'status', '--porcelain')).toString()).toBe(
		'',
	);
});

test('new refuses duplicate names without regard to case and reserved words', async () => {
	const f = await fixture();
	roots.push(f.root);
	await mkdir(join(f.home, 'Reading'));
	for (const name of ['reading', 'sync', 'Bad_Name']) {
		const result = await f.run('new', name, '--json');
		expect(result.code).toBe(2);
		expect(JSON.parse(result.stdout).error.code).toBe('usage');
	}
});
