/** An entry in apps/ is an app when it has code/epicenter.ts; a broken one is listed beside the apps that load. */
import { afterEach, expect, setDefaultTimeout, test } from 'bun:test';
import { rm } from 'node:fs/promises';
import { join } from 'node:path';
import { fixture } from './runner.test-support.js';

setDefaultTimeout(30_000);
const roots: string[] = [];
afterEach(async () => {
	for (const root of roots.splice(0))
		await rm(root, { recursive: true, force: true });
});
const code = `export default defineApp({description:'X',actions:{put:defineAction({description:'Write',input:{},run:async()=>{await folder.write('data/record.md','record');return Ok(folder.path);}})}});`;
test('missing and broken code entries list problems without hiding valid apps; a top-level epicenter.ts is not an app', async () => {
	const f = await fixture();
	roots.push(f.root);
	await f.app('valid', code);
	await f.folder(join(f.apps, 'legacy'), {
		'epicenter.ts': 'throw new Error("never import")',
	});
	await f.folder(join(f.apps, 'missing'), { 'data/a.md': 'record' });
	await f.folder(join(f.apps, 'broken'), {
		'code/epicenter.ts': 'throw new Error("broken")',
	});
	const listed = await f.run('--json');
	expect(listed.code).toBe(0);
	const result = JSON.parse(listed.stdout).data;
	expect(result.apps.map((app: { name: string }) => app.name)).toEqual([
		'valid',
	]);
	expect(
		result.problems.find((app: { entry: string }) => app.entry === 'legacy'),
	).toBeUndefined();
	expect(
		result.problems.find((app: { entry: string }) => app.entry === 'missing')
			.problems,
	).toEqual(['code/epicenter.ts is missing']);
});
