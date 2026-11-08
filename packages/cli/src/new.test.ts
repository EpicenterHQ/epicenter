import { afterEach, expect, test } from 'bun:test';
import { mkdir, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { fixture } from './runner.test-support.ts';

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
