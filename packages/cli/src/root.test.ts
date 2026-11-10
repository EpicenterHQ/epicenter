import { afterEach, expect, setDefaultTimeout, test } from 'bun:test';
import { mkdir, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fixture, declarationOf, TEST_ROOT_ID } from './runner.test-support.ts';

setDefaultTimeout(30_000);
const roots: string[] = [];
afterEach(async () => {
	for (const root of roots.splice(0))
		await rm(root, { recursive: true, force: true });
});

async function setup() {
	const f = await fixture();
	roots.push(f.root);
	return f;
}

test('init writes an identity and starter guidance, keeps existing guidance, and refuses nesting', async () => {
	const f = await setup();
	const folder = join(f.root, 'other');
	await mkdir(folder);
	await writeFile(join(folder, 'AGENTS.md'), 'Keep this guidance.\n');
	const result = await f.run('init', folder, '--port', '4748', '--json');
	expect(result.code).toBe(0);
	const made = JSON.parse(result.stdout);
	expect(made).toEqual({ folder, id: expect.any(String), port: 4748 });
	expect(
		JSON.parse(await readFile(join(folder, 'epicenter.root.json'), 'utf8')),
	).toEqual({ id: made.id, port: 4748 });
	expect(await readFile(join(folder, 'AGENTS.md'), 'utf8')).toBe(
		'Keep this guidance.\n',
	);
	expect((await f.run('init', folder, '--json')).code).toBe(2);
	expect((await f.run('init', join(folder, 'nested'), '--json')).code).toBe(2);
	expect((await f.runIn(folder, 'init', 'nested', '--json')).code).toBe(2);
	const alias = join(f.root, 'alias');
	await symlink(folder, alias);
	expect((await f.run('init', join(alias, 'nested'), '--json')).code).toBe(2);

	const fresh = join(f.root, 'fresh');
	const defaulted = await f.runIn(f.root, 'init', fresh, '--json');
	expect(defaulted.code).toBe(0);
	expect(JSON.parse(defaulted.stdout).port).toBe(4747);
	expect(await readFile(join(fresh, 'AGENTS.md'), 'utf8')).toContain(
		'*.local* is never committed',
	);
	const shown = await f.run('init', join(f.root, 'shown'));
	expect(shown.stdout).toContain(`Made Epicenter at ${join(f.root, 'shown')}`);
	expect(shown.stderr).toBe('Run: epicenter new <name>\n');
	const current = join(f.root, 'current');
	await mkdir(current);
	expect(
		JSON.parse((await f.runIn(current, 'init', '--json')).stdout).folder,
	).toBe(current);
});

test('walk-up wins over EPICENTER_ROOT, which wins over the default', async () => {
	const f = await setup();
	await f.folder(join(f.home, 'reading'), {
		'epicenter.json': declarationOf('reading'),
	});
	const other = join(f.root, 'other');
	expect((await f.run('init', other, '--json')).code).toBe(0);
	await f.folder(join(other, 'tasks'), {
		'epicenter.json': declarationOf('tasks'),
	});
	f.env.EPICENTER_ROOT = other;
	const fromOutside = JSON.parse((await f.run('--json')).stdout);
	expect(fromOutside.epicenter).toBe(other);
	expect((await f.run()).stdout).toContain(`Epicenter: other (${other})`);
	expect(fromOutside.apps.map((app: { name: string }) => app.name)).toEqual([
		'tasks',
	]);
	expect((await f.run('new', 'from-env')).code).toBe(0);
	expect(
		await Bun.file(join(other, 'from-env', 'epicenter.json')).exists(),
	).toBe(true);
	const fromInside = JSON.parse(
		(await f.runIn(join(f.home, 'reading'), '--json')).stdout,
	);
	expect(fromInside.epicenter).toBe(f.home);
	expect(fromInside.apps.map((app: { name: string }) => app.name)).toEqual([
		'reading',
	]);
	expect((await f.runIn(f.home, 'new', 'from-cwd')).code).toBe(0);
	expect(
		await Bun.file(join(f.home, 'from-cwd', 'epicenter.json')).exists(),
	).toBe(true);
	expect(
		JSON.parse((await f.runIn(f.home, 'reading', '--json')).stdout).keychain,
	).toBe(`epicenter.${TEST_ROOT_ID}.reading`);
	f.env.EPICENTER_ROOT = join(f.root, 'uninitialized');
	const missing = await f.run('--json');
	expect(missing.code).toBe(2);
	expect(JSON.parse(missing.stdout).error.next).toBe(
		`epicenter init ${f.env.EPICENTER_ROOT}`,
	);
	expect(
		JSON.parse((await f.run('invalid_name', '--json')).stdout).error.next,
	).toBe(`epicenter init ${f.env.EPICENTER_ROOT}`);
});

test('build reports each app and keeps the last good UI after failure', async () => {
	const f = await setup();
	await f.folder(join(f.home, 'capture'), {
		'epicenter.json': declarationOf('capture'),
	});
	const tasks = await f.folder(join(f.home, 'tasks'), {
		'epicenter.json': declarationOf('tasks'),
		'ui/package.json': JSON.stringify({
			private: true,
			scripts: { build: 'bun build.ts' },
		}),
		'ui/build.ts': `await Bun.write('../.cache/ui/index.html', 'good');\n`,
	});
	const first = await f.run('build', '--json');
	expect(first.code).toBe(0);
	expect(
		JSON.parse(first.stdout).apps.map(
			(app: { app: string; built: boolean }) => [app.app, app.built],
		),
	).toEqual([
		['capture', false],
		['tasks', true],
	]);
	expect(await readFile(join(tasks, '.cache/ui/index.html'), 'utf8')).toBe(
		'good',
	);
	await writeFile(
		join(tasks, 'ui/build.ts'),
		`throw new Error('build broke');\n`,
	);
	const failed = await f.run('build', 'tasks', '--json');
	expect(failed.code).toBe(1);
	expect(JSON.parse(failed.stdout).apps[0].error.message).toContain(
		'build broke',
	);
	expect(await readFile(join(tasks, '.cache/ui/index.html'), 'utf8')).toBe(
		'good',
	);
	expect((await f.run('build', 'capture')).stdout).toBe('capture: no ui/\n');
});

test('serve reads the root port when no command port is given', async () => {
	const f = await setup();
	await writeFile(
		join(f.home, 'epicenter.root.json'),
		JSON.stringify({ id: TEST_ROOT_ID, port: 0 }),
	);
	const child = Bun.spawn([process.execPath, f.bin, 'serve'], {
		cwd: f.root,
		env: f.env,
		stdout: 'ignore',
		stderr: 'pipe',
	});
	try {
		const reader = child.stderr.getReader();
		const started = (async () => {
			let output = '';
			for (;;) {
				const { value, done } = await reader.read();
				if (done) throw new Error(output || 'serve exited before listening');
				output += new TextDecoder().decode(value);
				if (/Serving your apps at http:\/\/127\.0\.0\.1:\d+\./.test(output))
					return;
			}
		})();
		await Promise.race([
			started,
			Bun.sleep(10_000).then(() => {
				throw new Error('serve did not start');
			}),
		]);
	} finally {
		child.kill('SIGTERM');
		await child.exited;
	}
});
