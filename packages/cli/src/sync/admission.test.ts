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
import { join, win32 } from 'node:path';
import { epicenterDataRoot } from '@epicenter/constants/app-data';
import { STATE_DIRECTORY } from '@epicenter/folder/bun';
import {
	canonicalPath,
	containsPath,
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
	expect(
		isReservedDirectory(await canonicalPath('missing/../objects/new', BOX)),
	).toBe(true);
	expect(await canonicalPath('a/./b/../c', BOX)).toBe(join(BOX, 'a/c'));
	expect(await canonicalPath(join(BOX, 'missing/.notes'))).toBe(
		join(BOX, 'missing/.notes'),
	);
});

/** `epicenter init <dir>` in a sandbox no repository encloses. */
async function init(dir: string, environment = 'production') {
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
				EPICENTER_ENVIRONMENT: environment,
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

test('Windows drive and backslash paths resolve with win32 semantics', async () => {
	const missing = async (_path: string): Promise<string> => {
		throw Object.assign(new Error('missing'), { code: 'ENOENT' });
	};
	expect(
		await canonicalPath(
			'C:\\Users\\Ada\\Epicenter\\..\\notes',
			'C:\\',
			win32,
			missing,
		),
	).toBe('C:\\Users\\Ada\\notes');
	expect(
		isReservedDirectory(
			await canonicalPath('D:\\work\\.GIT\\objects', 'C:\\', win32, missing),
		),
	).toBe(true);
	expect(containsPath('C:\\Users\\Ada', 'C:\\Users\\Ada\\notes', win32)).toBe(
		true,
	);
	expect(containsPath('C:\\Users\\Ada', 'C:\\Users\\Adam\\notes', win32)).toBe(
		false,
	);
	expect(containsPath('C:\\Users\\Ada', 'D:\\notes', win32)).toBe(false);
	expect(
		canonicalPath('C:\\blocked', 'C:\\', win32, async () => {
			throw Object.assign(new Error('denied'), { code: 'EACCES' });
		}),
	).rejects.toThrow('denied');
});

test('both library roots are refused in either environment', async () => {
	for (const environment of ['production', 'development'])
		for (const name of ['Epicenter', 'Epicenter Dev']) {
			const target = join(BOX, 'home', name);
			const result = await init(target, environment);
			expect(result.code).toBe(2);
			expect(existsSync(target)).toBe(false);
		}
}, 60_000);

test('both application data directories are refused in either environment', async () => {
	for (const environment of ['production', 'development'])
		for (const identifier of ['so.epicenter', 'so.epicenter.dev']) {
			const target = epicenterDataRoot(
				{ env: {}, platform: process.platform, homeDir: join(BOX, 'home') },
				identifier,
			);
			const result = await init(target, environment);
			expect(result.code).toBe(2);
			expect(existsSync(target)).toBe(false);
		}
}, 60_000);

test('a refused init inside an enclosing repository leaves no directory', async () => {
	const parent = join(BOX, 'existing-repo');
	mkdirSync(parent);
	const git = Bun.spawnSync(['git', 'init', '-q', parent], { cwd: BOX });
	expect(git.exitCode).toBe(0);
	const target = join(parent, 'new', 'folder');
	const refused = await init(target);
	expect(refused.code).toBe(2);
	expect(existsSync(join(parent, 'new'))).toBe(false);
}, 60_000);

test('development registration uses a separate global key', async () => {
	const production = join(BOX, 'prod-folder');
	const development = join(BOX, 'dev-folder');
	expect((await init(production)).code).toBe(0);
	expect((await init(development, 'development')).code).toBe(0);
	const config = readFileSync(join(BOX, 'home', '.gitconfig'), 'utf8');
	expect(config).toContain('folder = ' + production);
	expect(config).toContain('devFolder = ' + development);
}, 60_000);

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

test('init checks a linked target against home and application data', async () => {
	const home = join(BOX, 'home');
	mkdirSync(home, { recursive: true });
	mkdirSync(join(BOX, 'data'), { recursive: true });
	for (const [target, name] of [
		[home, 'home-link'],
		[join(BOX, 'data'), 'data-link'],
	] as const) {
		const link = join(BOX, name);
		symlinkSync(target, link);
		const refused = await init(link);
		expect(refused.code).toBe(2);
		expect(refused.out).toContain('refused:');
		expect(existsSync(join(target, '.git'))).toBe(false);
	}
}, 60_000);
