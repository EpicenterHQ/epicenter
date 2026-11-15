/** Container identity survives code replacement; CLI and HTTP writes preserve root HEAD and never create nested repositories. */
import { afterEach, expect, setDefaultTimeout, test } from 'bun:test';
import {
	mkdir,
	readdir,
	readFile,
	rename,
	rm,
	writeFile,
} from 'node:fs/promises';
import { join } from 'node:path';
import { checkpoint } from './checkpoint.js';
import { hold } from './lock.js';
import { fixture, gitIn, header, startServe } from './runner.test-support.js';

setDefaultTimeout(30_000);
const roots: string[] = [];
afterEach(async () => {
	for (const root of roots.splice(0))
		await rm(root, { recursive: true, force: true });
});
const code = `export default defineApp({description:'X',collections:{},actions:{put:defineAction({description:'Write',input:{},run:async()=>{await folder.write('data/record.md','record');return folder.path;}})}});`;
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
	await checkpoint(f.home);
	const before = await gitIn(f.home, 'rev-parse', 'HEAD');
	const cli = await f.run('x', 'put', '--json');
	expect(cli.code).toBe(0);
	expect(JSON.parse(cli.stdout)).toEqual({ returned: app });
	expect(await readFile(join(app, 'data/record.md'), 'utf8')).toBe('record');
	expect(await gitIn(f.home, 'rev-parse', 'HEAD')).toBe(before);
	await assertNoGit(f.apps);
	const served = await startServe(f);
	try {
		// Startup checkpoint owns prior pending changes; wait for that tick to finish.
		for (
			let tries = 0;
			tries < 100 && (await gitIn(f.home, 'rev-parse', 'HEAD')) === before;
			tries++
		)
			await Bun.sleep(20);
		const started = await gitIn(f.home, 'rev-parse', 'HEAD');
		await rm(join(app, 'data/record.md'));
		const response = await fetch(`${served.base}/x/put`, {
			method: 'POST',
			body: '{}',
		});
		expect(JSON.parse(await response.text())).toEqual({
			answer: { returned: app },
		});
		expect(await readFile(join(app, 'data/record.md'), 'utf8')).toBe('record');
		expect(await gitIn(f.home, 'rev-parse', 'HEAD')).toBe(started);
		await assertNoGit(f.apps);
	} finally {
		await served.stop();
	}
});

test('a waiting action keeps locking the container when code is replaced', async () => {
	const f = await fixture();
	roots.push(f.root);
	const app = await f.app('x', code);
	const held = await hold(app, 0);
	expect(held).toBeDefined();
	let done = false;
	const start = Date.now();
	const call = f.run('x', 'put', '--json');
	void call.then(() => {
		done = true;
	});
	try {
		await Bun.sleep(200);
		expect(done).toBe(false);
		await rename(join(app, 'code'), join(app, 'old-code'));
		await mkdir(join(app, 'code'));
		await writeFile(join(app, 'code/epicenter.ts'), header + code);
		await Bun.sleep(200);
		expect(done).toBe(false);
	} finally {
		held?.release();
	}
	const result = await call;
	expect(result.code).toBe(0);
	expect(Date.now() - start).toBeGreaterThanOrEqual(400);
	expect(JSON.parse(result.stdout)).toEqual({ returned: app });
	expect(await readFile(join(app, 'data/record.md'), 'utf8')).toBe('record');
});

test('legacy, missing, and broken code entries list problems without hiding valid apps', async () => {
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
		result.problems.find((app: { entry: string }) => app.entry === 'legacy')
			.problems[0],
	).toContain(
		"epicenter.ts is at the app's top; move the app's code into code/",
	);
	expect(
		result.problems.find((app: { entry: string }) => app.entry === 'missing')
			.problems,
	).toEqual(['code/epicenter.ts is missing']);
	expect((await f.run('install', 'missing', '--json')).code).toBe(1);
	expect((await f.run('build', 'missing', '--json')).code).toBe(1);
});
