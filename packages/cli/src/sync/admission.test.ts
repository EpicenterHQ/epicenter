/**
 * Admission Tests
 *
 * Where a data folder can never be is one rule in two languages:
 * `admission.ts` here and `admission.rs` in the folder core. Both read
 * `fixtures/reserved-directories.json`, so a change on one side fails the
 * other's suite.
 *
 * Key behaviors:
 * - The reserved names are the shared fixture's, `.epicenter` spelled by
 *   `@epicenter/folder`'s `STATE_DIRECTORY`
 * - Every canonical path the fixture refuses is refused, and every one it
 *   allows is allowed
 * - A canonical path follows a link on the way and keeps a missing rest as
 *   written, so a link is no route around the rule
 * - `epicenter init` refuses `x/.git/y` and `x/.EPICENTER/y` before it makes
 *   anything, and sets up `~/.notes`
 */
import { afterAll, expect, test } from 'bun:test';
import {
	existsSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	realpathSync,
	rmSync,
	symlinkSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { STATE_DIRECTORY } from '@epicenter/folder/bun';
import {
	canonicalPath,
	isReservedDirectory,
	RESERVED_DIRECTORIES,
} from './admission.ts';

/** The paths `admission.rs` reads too. */
const fixture = JSON.parse(
	readFileSync(
		join(
			import.meta.dir,
			'../../../tauri-plugin-epicenter-folder/fixtures/reserved-directories.json',
		),
		'utf8',
	),
) as { reserved: string[]; refused: string[]; allowed: string[] };

const BOX = realpathSync(mkdtempSync(join(tmpdir(), 'epicenter-admission-')));
afterAll(() => rmSync(BOX, { recursive: true, force: true }));

test('the reserved names are the shared fixture’s', () => {
	expect<string[]>([...RESERVED_DIRECTORIES]).toEqual(fixture.reserved);
	expect(RESERVED_DIRECTORIES).toContain(STATE_DIRECTORY);
});

test('every path the fixture refuses is refused, and every one it allows is allowed', () => {
	for (const path of fixture.refused)
		expect([path, isReservedDirectory(path)]).toEqual([path, true]);
	for (const path of fixture.allowed)
		expect([path, isReservedDirectory(path)]).toEqual([path, false]);
});

test('a canonical path follows a link on the way and keeps a missing rest as written', async () => {
	mkdirSync(join(BOX, 'repository/.git/objects'), { recursive: true });
	symlinkSync(join(BOX, 'repository/.git'), join(BOX, 'objects'));
	expect(await canonicalPath('objects/new/y', BOX)).toBe(
		join(BOX, 'repository/.git/new/y'),
	);
	expect(isReservedDirectory(await canonicalPath('objects/new', BOX))).toBe(
		true,
	);
	expect(await canonicalPath('a/./b/../c', BOX)).toBe(join(BOX, 'a/c'));
	expect(await canonicalPath(join(BOX, 'missing/.notes'))).toBe(
		join(BOX, 'missing/.notes'),
	);
});

/** `epicenter init <dir>` in a sandbox no repository encloses. */
async function init(dir: string) {
	const home = join(BOX, 'home');
	const proc = Bun.spawn(
		['bun', join(import.meta.dir, '..', 'bin.ts'), 'init', dir],
		{
			cwd: BOX,
			env: {
				PATH: process.env.PATH ?? '/usr/bin:/bin',
				HOME: home,
				GIT_CONFIG_GLOBAL: join(home, '.gitconfig'),
				GIT_CONFIG_NOSYSTEM: '1',
				GIT_CEILING_DIRECTORIES: BOX,
				EPICENTER_DATA_DIR: join(BOX, 'data'),
			},
			stdout: 'pipe',
			stderr: 'pipe',
		},
	);
	const [stdout, stderr, code] = await Promise.all([
		new Response(proc.stdout).text(),
		new Response(proc.stderr).text(),
		proc.exited,
	]);
	return { code, out: `${stdout}${stderr}` };
}

test('init refuses a folder inside .git or .epicenter before it makes anything, and sets up ~/.notes', async () => {
	for (const dir of ['x/.git/y', 'x/.EPICENTER/y']) {
		const refused = await init(dir);
		expect(refused.code).toBe(2);
		expect(refused.out).toContain(
			`refused: ${join(BOX, dir)} is inside a .git or .epicenter folder, which belong to Git and to Epicenter, so it cannot be a data folder.`,
		);
		expect(existsSync(join(BOX, dir))).toBe(false);
	}
	const notes = await init('home/.notes');
	expect(notes.code).toBe(0);
	expect(existsSync(join(BOX, 'home/.notes/.git'))).toBe(true);
}, 60_000);
