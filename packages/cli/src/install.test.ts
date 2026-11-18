/**
 * The workspace a home is.
 *
 * A home is one Bun workspace, so one `bun install` at its top serves every
 * app. Epicenter has no install command, and `new` installs nothing: a person
 * runs `bun install`. Fixture packages name nothing to fetch, so no registry
 * is asked.
 *
 * Key behaviors:
 * - `bun install` run inside an app installs at the top of the home, and
 *   writes the home's one lock, naming each app's package.
 * - A package the owner added to `workspaces`, nested inside an app, is
 *   installed with the rest and is not taken for an app.
 * - An app that would load a second copy of `@epicenter/app` is a problem
 *   that names both copies.
 */
import { afterEach, expect, test } from 'bun:test';
import { existsSync } from 'node:fs';
import { mkdir, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { bareApp, fixture } from './runner.test-support.ts';

const roots: string[] = [];
afterEach(async () => {
	await Promise.all(
		roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
	);
});

async function setup() {
	const f = await fixture();
	roots.push(f.root);
	const notes = await f.folder(join(f.apps, 'notes'), {
		'code/epicenter.ts': bareApp('notes'),
		'code/package.json': '{ "name": "notes", "private": true }\n',
	});
	return { ...f, notes };
}

/** A person's `bun install`, run in `cwd` with the Bun that runs the tests. */
async function bunInstall(cwd: string) {
	const child = Bun.spawn([process.execPath, 'install'], {
		cwd,
		stdout: 'ignore',
		stderr: 'ignore',
	});
	return child.exited;
}

test('bun install inside an app installs at the top of the home, in one lock', async () => {
	const f = await setup();
	expect(await bunInstall(join(f.notes, 'code'))).toBe(0);
	expect(await readFile(join(f.home, 'bun.lock'), 'utf8')).toContain(
		'"apps/notes/code"',
	);
	expect(existsSync(join(f.notes, 'code/bun.lock'))).toBe(false);
});

test('a package nested inside an app, added to workspaces by hand, installs with the home and is not an app', async () => {
	const f = await setup();
	await writeFile(
		join(f.home, 'package.json'),
		`${JSON.stringify({ private: true, workspaces: ['apps/*/code', 'apps/notes/code/render'] })}\n`,
	);
	await f.folder(join(f.notes, 'code/render'), {
		'package.json': '{ "name": "notes-render", "private": true }\n',
		'index.ts': 'export const frames = 24;\n',
	});
	expect(await bunInstall(f.home)).toBe(0);
	const lock = await readFile(join(f.home, 'bun.lock'), 'utf8');
	expect(lock).toContain('"apps/notes/code"');
	expect(lock).toContain('"apps/notes/code/render"');

	const listed = JSON.parse((await f.run('--json')).stdout).data;
	expect(listed.apps.map((app: { name: string }) => app.name)).toEqual([
		'notes',
	]);
	expect(listed.problems).toEqual([]);
	// `new` leaves the owner's entry alone.
	expect((await f.run('new', 'garden')).code).toBe(0);
	expect(
		(await Bun.file(join(f.home, 'package.json')).json()).workspaces,
	).toEqual(['apps/*/code', 'apps/notes/code/render']);
	expect(
		JSON.parse((await f.run('--json')).stdout).data.apps.map(
			(app: { name: string }) => app.name,
		),
	).toEqual(['garden', 'notes']);
});

test('an app that would load a second copy of @epicenter/app is a problem naming both copies; an uninstalled home says to install', async () => {
	const f = await setup();
	// A copy of its own in the app's folder, as a per-app install left one.
	const own = join(f.notes, 'code/node_modules/@epicenter/app');
	await mkdir(join(own, 'src'), { recursive: true });
	await writeFile(
		join(own, 'package.json'),
		'{ "name": "@epicenter/app", "exports": { ".": "./src/index.ts" } }\n',
	);
	await writeFile(join(own, 'src/index.ts'), 'export {};\n');
	const ours = await realpath(join(import.meta.dir, '../../app'));
	const next = 'run bun install at the top of the home';
	expect(JSON.parse((await f.run('--json')).stdout).data.problems).toEqual([
		{
			entry: 'notes',
			folder: f.notes,
			problems: [
				`apps/notes resolves @epicenter/app at ${await realpath(own)}, and epicenter runs ${ours}; ${next}`,
			],
		},
	]);

	await rm(join(f.notes, 'code/node_modules'), { recursive: true });
	await rm(join(f.home, 'node_modules'), { recursive: true });
	const uninstalled = JSON.parse((await f.run('--json')).stdout).data;
	expect(uninstalled.problems[0].problems).toEqual([
		`apps/notes finds no @epicenter/app from ${await realpath(join(f.notes, 'code'))}; ${next}`,
	]);
});
