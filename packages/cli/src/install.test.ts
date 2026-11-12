/**
 * App installation runs from the app's top, respects the frozen lock, and
 * supplies the command's @epicenter/app link even without a lockfile.
 * Fixtures use local workspaces so no registry or person's home is touched.
 */
import { afterEach, expect, test } from 'bun:test';
import { realpath, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { bareApp, fixture, gitIn } from './runner.test-support.ts';

const roots: string[] = [];
afterEach(async () => {
	await Promise.all(
		roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
	);
});

/** Generate a lock for a package with no dependencies and one local workspace. */
async function setup() {
	const f = await fixture();
	roots.push(f.root);
	f.env.BUN_INSTALL = join(f.root, 'bun');
	const app = await f.folder(join(f.apps, 'notes'), {
		'.gitignore': 'data/\nnode_modules/\n',
		'epicenter.ts': bareApp('notes'),
		'package.json': JSON.stringify({
			name: 'notes',
			version: '1.0.0',
			workspaces: ['local'],
		}),
		'local/package.json': JSON.stringify({
			name: 'offline-local',
			version: '1.0.0',
		}),
		'extra/package.json': JSON.stringify({
			name: 'offline-extra',
			version: '1.0.0',
		}),
	});
	const child = Bun.spawn([process.execPath, 'install'], {
		cwd: app,
		env: f.env,
		stdout: 'pipe',
		stderr: 'pipe',
	});
	const [code, stderr] = await Promise.all([
		child.exited,
		new Response(child.stderr).text(),
		new Response(child.stdout).text(),
	]);
	expect({ code, stderr }).toMatchObject({ code: 0 });
	expect(await Bun.file(join(app, 'bun.lock')).exists()).toBe(true);
	return { ...f, dir: app };
}

test('install uses bun.lock at the app top and links the supplied package', async () => {
	const f = await setup();
	const result = await f.run('install', 'notes', '--json');
	expect(result.code).toBe(0);
	expect(JSON.parse(result.stdout)).toEqual({
		apps: [{ app: 'notes', folder: f.dir, installed: true }],
	});
	expect(await realpath(join(f.dir, 'node_modules/@epicenter/app'))).toBe(
		await realpath(join(import.meta.dir, '../../app')),
	);
	expect((await f.run('install', 'notes')).stdout).toBe(
		'notes: installed packages and linked @epicenter/app\n',
	);
});

test('install without bun.lock only links the supplied package', async () => {
	const f = await fixture();
	roots.push(f.root);
	const app = await f.app(
		'notes',
		"export default defineApp({ description: 'Notes', collections: {}, actions: {} });",
	);
	const result = await f.run('install', '--json');
	expect(result.code).toBe(0);
	expect(JSON.parse(result.stdout)).toEqual({
		apps: [{ app: 'notes', folder: app, installed: false }],
	});
	expect(await realpath(join(app, 'node_modules/@epicenter/app'))).toBe(
		await realpath(join(import.meta.dir, '../../app')),
	);
	expect((await f.run('install', 'notes')).stdout).toBe(
		'notes: linked @epicenter/app\n',
	);
});

test('install without bun.lock installs a top-level package.json', async () => {
	const f = await fixture();
	roots.push(f.root);
	const app = await f.folder(join(f.apps, 'notes'), {
		'.gitignore': 'data/\nnode_modules/\n',
		'epicenter.ts': bareApp('notes'),
		'package.json': JSON.stringify({
			name: 'notes',
			version: '1.0.0',
			workspaces: ['local'],
		}),
		'local/package.json': JSON.stringify({
			name: 'offline-local',
			version: '1.0.0',
		}),
	});
	const result = await f.run('install', 'notes', '--json');
	expect(result.code).toBe(0);
	expect(JSON.parse(result.stdout).apps[0].installed).toBe(true);
	expect(await Bun.file(join(app, 'bun.lock')).exists()).toBe(true);
	expect(await realpath(join(app, 'node_modules/@epicenter/app'))).toBe(
		await realpath(join(import.meta.dir, '../../app')),
	);
});

test('a frozen mismatch fails with a repair command and does not stop the other apps', async () => {
	const f = await setup();
	await writeFile(
		join(f.dir, 'package.json'),
		JSON.stringify({
			name: 'notes',
			version: '1.0.0',
			workspaces: ['local'],
			dependencies: { 'offline-extra': 'file:./extra' },
		}),
	);
	const other = await f.app(
		'other',
		"export default defineApp({ description: 'Other', collections: {}, actions: {} });",
	);
	const result = await f.run('install', '--json');
	expect(result.code).toBe(1);
	const apps = JSON.parse(result.stdout).apps;
	expect(
		apps.find((app: { app: string }) => app.app === 'notes'),
	).toMatchObject({
		installed: false,
		error: {
			message: expect.stringContaining('frozen'),
			next: `cd ${f.dir} && bun install && epicenter install notes`,
		},
	});
	expect(apps.find((app: { app: string }) => app.app === 'other')).toEqual({
		app: 'other',
		folder: other,
		installed: false,
	});
	const text = await f.run('install', 'notes');
	expect(text.code).toBe(1);
	expect(text.stderr).toContain('notes: ');
	expect(text.stderr).toContain(
		`Run: cd ${f.dir} && bun install && epicenter install notes`,
	);
});

test('new keeps a cloned app when its frozen install fails', async () => {
	const f = await setup();
	await writeFile(
		join(f.dir, 'package.json'),
		JSON.stringify({
			name: 'notes',
			workspaces: ['local'],
			dependencies: { 'offline-extra': 'file:./extra' },
		}),
	);
	await gitIn(f.dir, 'add', 'package.json', 'bun.lock');
	await gitIn(f.dir, 'commit', '-qm', 'mismatched lock');
	const made = await f.run('new', 'copy', '--from', f.dir, '--json');
	expect(made.code).toBe(1);
	const copy = join(f.apps, 'copy');
	expect(JSON.parse(made.stdout)).toMatchObject({
		name: 'copy',
		folder: copy,
		error: {
			message: expect.stringContaining('frozen'),
			next: `cd ${copy} && bun install && epicenter install copy`,
		},
	});
	expect(await Bun.file(join(copy, 'epicenter.ts')).exists()).toBe(true);
	expect(await gitIn(join(copy, 'data'), 'log', '-1', '--format=%s')).toBe(
		'copy: start its data',
	);
});

test('update reports a frozen install failure after merging and keeps the app', async () => {
	const f = await setup();
	await gitIn(f.dir, 'add', 'bun.lock');
	await gitIn(f.dir, 'commit', '-qm', 'lock packages');
	expect((await f.run('new', 'copy', '--from', f.dir)).code).toBe(0);
	await writeFile(
		join(f.dir, 'package.json'),
		JSON.stringify({
			name: 'notes',
			workspaces: ['local'],
			dependencies: { 'offline-extra': 'file:./extra' },
		}),
	);
	await gitIn(f.dir, 'add', 'package.json');
	await gitIn(f.dir, 'commit', '-qm', 'mismatched lock');
	const updated = await f.run('update', 'copy', '--json');
	expect(updated.code).toBe(1);
	expect(JSON.parse(updated.stdout).apps[0]).toMatchObject({
		app: 'copy',
		found: true,
		merged: expect.any(String),
		error: {
			message: expect.stringContaining('copy: '),
			next: `cd ${join(f.apps, 'copy')} && bun install && epicenter install copy`,
		},
	});
});
