/** `new` makes a blank app container: code/ named for the app, and an empty data/. */
import { afterEach, expect, test } from 'bun:test';
import { existsSync } from 'node:fs';
import { lstat, mkdir, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { fixture, gitIn } from './runner.test-support.ts';

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

async function noNestedGit(folder: string): Promise<void> {
	const { readdir } = await import('node:fs/promises');
	for (const entry of await readdir(folder, { withFileTypes: true })) {
		expect(entry.name).not.toBe('.git');
		if (entry.isDirectory()) await noNestedGit(join(folder, entry.name));
	}
}

test('new creates code and empty data without repositories and refuses taken and reserved names', async () => {
	const f = await setup();
	await gitIn(f.home, 'init', '-q');
	await mkdir(join(f.apps, 'Reading'));
	for (const name of ['reading', 'serve', 'init', 'Bad_Name'])
		expect((await f.run('new', name, '--json')).code).toBe(2);
	expect(JSON.parse((await f.run('new', 'reading', '--json')).stdout)).toEqual({
		data: null,
		error: {
			name: 'NotStarted',
			cause: 'usage',
			message: `reading already exists in ${f.apps}`,
		},
	});
	const made = await f.run('new', 'garden', '--json');
	expect(made.code).toBe(0);
	const container = join(f.apps, 'garden');
	expect(JSON.parse(made.stdout)).toEqual({
		data: { name: 'garden', folder: container },
		error: null,
	});
	expect(await readFile(join(container, 'code/.gitignore'), 'utf8')).toBe(
		'node_modules/\nui/dist/\n',
	);
	expect((await lstat(join(container, 'data'))).isDirectory()).toBe(true);
	// A package of the home's workspace, named for the app, that lists nothing:
	// @epicenter/app comes from the home, which holds the one lock and install.
	expect(await Bun.file(join(container, 'code/package.json')).json()).toEqual({
		name: 'garden',
		private: true,
	});
	for (const path of ['code/bun.lock', 'code/node_modules', 'node_modules'])
		expect(existsSync(join(container, path))).toBe(false);
	expect((await f.run('garden', '--json')).code).toBe(0);
	await noNestedGit(f.apps);
});

test('new installs and builds nothing, and prints the one command that does both', async () => {
	const f = await setup();
	const made = await f.run('new', 'garden');
	expect(made).toMatchObject({
		code: 0,
		stdout: `${join(f.apps, 'garden')}\n`,
	});
	expect(made.stderr).toBe(
		`Run: cd ${f.home} && bun install && bun run build\n`,
	);
	expect(existsSync(join(f.home, 'bun.lock'))).toBe(false);
});
