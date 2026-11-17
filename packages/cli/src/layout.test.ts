/** Container identity survives code replacement; CLI and HTTP writes preserve root HEAD and never create nested repositories. */
import { afterEach, expect, setDefaultTimeout, test } from 'bun:test';
import { readdir, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { connect } from '@epicenter/app/client';
import type { Ok } from 'wellcrafted/result';
import { expectOk } from 'wellcrafted/testing';
import { fixture, gitIn, startServe } from './runner.test-support.js';

setDefaultTimeout(30_000);
const roots: string[] = [];
afterEach(async () => {
	for (const root of roots.splice(0))
		await rm(root, { recursive: true, force: true });
});
const code = `export default defineApp({description:'X',actions:{put:defineAction({description:'Write',input:{},run:async()=>{await folder.write('data/record.md','record');return Ok(folder.path);}})}});`;
async function assertNoGit(folder: string): Promise<void> {
	for (const entry of await readdir(folder, { withFileTypes: true })) {
		expect(entry.name).not.toBe('.git');
		if (entry.isDirectory()) await assertNoGit(join(folder, entry.name));
	}
}

test('CLI and HTTP writes use container paths and leave the root commit unchanged', async () => {
	const f = await fixture();
	roots.push(f.root);
	await gitIn(f.home, 'init', '-q');
	const app = await f.app('x', code);
	await gitIn(f.home, 'add', '-A');
	await gitIn(f.home, 'commit', '-qm', 'start');
	const before = await gitIn(f.home, 'rev-parse', 'HEAD');
	const cli = await f.run('x', 'put', '--json');
	expect(cli.code).toBe(0);
	expect(JSON.parse(cli.stdout)).toEqual({ data: app, error: null });
	expect(await readFile(join(app, 'data/record.md'), 'utf8')).toBe('record');
	expect(await gitIn(f.home, 'rev-parse', 'HEAD')).toBe(before);
	await assertNoGit(f.apps);
	const served = await startServe(f);
	try {
		const started = await gitIn(f.home, 'rev-parse', 'HEAD');
		await rm(join(app, 'data/record.md'));
		const client = connect<{ actions: { put: () => Promise<Ok<string>> } }>({
			app: 'x',
			url: `${served.base}/`,
		});
		expect(expectOk(await client.put({}))).toBe(app);
		expect(await readFile(join(app, 'data/record.md'), 'utf8')).toBe('record');
		expect(await gitIn(f.home, 'rev-parse', 'HEAD')).toBe(started);
		await assertNoGit(f.apps);
	} finally {
		await served.stop();
	}
});

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
	const result = JSON.parse(listed.stdout);
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
	expect((await f.run('build', 'missing', '--json')).code).toBe(1);
});
