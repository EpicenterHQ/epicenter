/**
 * What keeps secrets out of Git (ADR-0963)
 *
 * An app's `local/` and the root `.env` hold tokens and keys. The folder
 * writes `local/.gitignore` when it makes `local/`; these tests cover the
 * two places Epicenter catches what the folder did not make.
 *
 * Key behaviors:
 * - An app whose `local/` has no `.gitignore` still runs, and the listing,
 *   `epicenter check` and serve's start each name it with the fix.
 * - Serve refuses to start when Git tracks the root `.env` or would not
 *   ignore it, and starts when Git ignores it or the folder is not a
 *   repository.
 */
import { afterEach, expect, setDefaultTimeout, test } from 'bun:test';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { bareApp, fixture, startServe } from './runner.test-support.ts';

setDefaultTimeout(30_000);
const roots: string[] = [];
afterEach(async () => {
	await Promise.all(
		roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
	);
});

/** Git with no settings from this computer, so a global excludes file cannot ignore `.env` for it. */
const quietGit = {
	GIT_CONFIG_GLOBAL: '/dev/null',
	GIT_CONFIG_NOSYSTEM: '1',
};

async function setup() {
	const f = await fixture();
	roots.push(f.userDir);
	Object.assign(f.env, quietGit);
	await f.folder(join(f.apps, 'notes'), {
		'code/epicenter.ts': bareApp('notes'),
	});
	return f;
}

/** Run Git in `cwd` as the tests' serve runs it. */
async function git(cwd: string, ...args: string[]) {
	const child = Bun.spawn(['git', ...args], {
		cwd,
		env: { ...process.env, ...quietGit },
		stdout: 'ignore',
		stderr: 'ignore',
	});
	expect(await child.exited).toBe(0);
}

const fix =
	"apps/notes/local has no .gitignore; run: echo '*' > apps/notes/local/.gitignore";

test('an app whose local/ has no .gitignore runs, and the listing, check and serve name the fix', async () => {
	const f = await setup();
	await mkdir(join(f.apps, 'notes', 'local'));

	const listed = JSON.parse((await f.run('--json')).stdout).data;
	expect(listed.apps.map((app: { name: string }) => app.name)).toEqual([
		'notes',
	]);
	expect(listed.problems).toEqual([
		{ entry: 'notes', folder: join(f.apps, 'notes'), problems: [fix] },
	]);

	const checked = await f.run('check', 'notes', '--json');
	expect(checked.code).toBe(1);
	expect(JSON.parse(checked.stdout).error.report.problems).toEqual([
		{ entry: 'notes', folder: join(f.apps, 'notes'), problems: [fix] },
	]);

	const served = await startServe(f);
	try {
		for (let tries = 0; !served.stderr().includes(fix) && tries < 50; tries++)
			await Bun.sleep(20);
		expect(served.stderr()).toContain(`\n${fix}\n`);
	} finally {
		await served.stop();
	}

	await writeFile(join(f.apps, 'notes', 'local', '.gitignore'), '*\n');
	expect(JSON.parse((await f.run('--json')).stdout).data.problems).toEqual([]);
	expect((await f.run('check', 'notes')).code).toBe(0);
});

test('serve refuses to start while Git would commit the root .env, and says the fix', async () => {
	const f = await setup();
	await git(f.epicenter, 'init', '-q');
	await writeFile(join(f.epicenter, '.env'), 'KEY=secret\n');
	expect(await f.run('serve')).toEqual({
		code: 2,
		stdout: '',
		stderr: '.env is not ignored by Git; add .env* to .gitignore\n',
	});

	await writeFile(join(f.epicenter, '.gitignore'), '.env*\n');
	await git(f.epicenter, 'add', '-f', '.env');
	expect(await f.run('serve')).toEqual({
		code: 2,
		stdout: '',
		stderr: '.env is tracked by Git; run git rm --cached .env\n',
	});

	await git(f.epicenter, 'rm', '-q', '--cached', '.env');
	const served = await startServe(f);
	await served.stop();
});

test('serve starts with a .env in a folder that is not a Git repository', async () => {
	const f = await setup();
	await writeFile(join(f.epicenter, '.env'), 'KEY=secret\n');
	const served = await startServe(f);
	await served.stop();
});
