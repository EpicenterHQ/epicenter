/**
 * Local Declaration Tests
 *
 * The desktop's Sync and Save version run in the `epicenter` CLI
 * (`runHistory`), which reads the folder's definition from its own
 * `epicenter.json`. So `local` lives in that file, and the CLI leaves the
 * paths it names out of every commit with no `.gitignore` to help.
 *
 * Key behaviors:
 * - `formatDefinition` writes `local`, and `parseDefinition` and
 *   `readDefinition` read it back; a declaration without it stays valid
 * - A declared pattern that cannot be a `.gitignore` line is refused on read
 * - `local` is sorted and kept once each, so the declaration's bytes do not
 *   depend on the order it was written in
 * - `runHistory`'s sync, with `epicenter.json` declaring `audio/` and no
 *   `.gitignore`, pushes no audio; a WAV committed earlier is untracked and
 *   kept on disk
 * - An `epicenter.json` that is there but cannot be used refuses a save
 *   version and a sync, and pushes nothing; status still reads
 */
import { afterAll, afterEach, beforeAll, expect, test } from 'bun:test';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { expectOk } from 'wellcrafted/testing';
import { runHistory } from './bun.js';
import { defineFolder, defineTable, field } from './contract.js';
import { formatDefinition, parseDefinition } from './declaration.js';
import { prepareFolderDefinition } from './definition.js';
import {
	GIT_ENV,
	git,
	initWithOrigin,
	scratch,
} from './git-http.test-support.js';

const tables = {
	recordings: defineTable({ fields: { title: field.string() } }),
};
const definition = defineFolder({ tables, local: ['audio/'] });
const author = { name: 'Recorder', email: 'recorder@example.test' };
const originalGlobal = process.env.GIT_CONFIG_GLOBAL;
const roots: string[] = [];

beforeAll(() => {
	process.env.GIT_CONFIG_GLOBAL = GIT_ENV.GIT_CONFIG_GLOBAL;
});
afterAll(() => {
	if (originalGlobal === undefined) delete process.env.GIT_CONFIG_GLOBAL;
	else process.env.GIT_CONFIG_GLOBAL = originalGlobal;
});
afterEach(async () => {
	for (const root of roots.splice(0))
		await rm(root, { recursive: true, force: true });
});

test('local is written into epicenter.json and read back', () => {
	const text = formatDefinition(definition);
	expect(JSON.parse(text).local).toEqual(['audio/']);
	expect(expectOk(parseDefinition(text)).local).toEqual(['audio/']);
	// Its bytes change with `local`, so publishing writes the new list.
	expect(formatDefinition(defineFolder({ tables }))).not.toBe(text);
	expect(
		expectOk(parseDefinition(formatDefinition(defineFolder({ tables })))).local,
	).toBeUndefined();
});

test('a declared local that is not .gitignore lines is refused when read', () => {
	const declared = JSON.parse(formatDefinition(definition));
	const text = (local: unknown) => JSON.stringify({ ...declared, local });
	for (const local of ['audio/', [3]])
		expect(parseDefinition(text(local)).error?.reason).toContain("'local'");
	for (const local of [['!audio/x.wav'], ['# audio'], [' audio/']]) {
		const parsed = expectOk(parseDefinition(text(local)));
		expect(prepareFolderDefinition(parsed).error?.reason).toContain(
			'local pattern',
		);
	}
});

test('local formats to the same bytes whatever its order or repeats', () => {
	const ordered = defineFolder({
		tables,
		local: ['drafts/', 'audio/'],
	});
	const repeated = defineFolder({
		tables,
		local: ['audio/', 'drafts/', 'audio/'],
	});
	expect(ordered.local).toEqual(['audio/', 'drafts/']);
	expect(formatDefinition(repeated)).toBe(formatDefinition(ordered));
	// Read back from the file, it is the same list.
	const read = expectOk(parseDefinition(formatDefinition(repeated)));
	expect(expectOk(prepareFolderDefinition(read)).local).toEqual([
		'audio/',
		'drafts/',
	]);
});

/** A folder on disk as the desktop leaves it: a repository with `origin`, and its own epicenter.json. */
async function desktopFolder() {
	const root = await scratch('local-declaration-');
	roots.push(root);
	const bare = join(root, 'remote.git');
	await git(root, 'init', '--quiet', '--bare', '--initial-branch=main', bare);
	const directory = join(root, 'folder');
	await initWithOrigin(directory, bare);
	const write = async (path: string, text: string) => {
		await mkdir(join(directory, path, '..'), { recursive: true });
		await writeFile(join(directory, path), text);
	};
	const sync = async () => {
		const reply = await runHistory(directory, { op: 'sync' }, { author });
		expect(expectOk(reply.result as never)).toMatchObject({ kind: 'synced' });
	};
	const remoteTree = async () =>
		(await git(bare, 'ls-tree', '-r', '--name-only', 'main'))
			.split('\n')
			.sort();
	return { directory, write, sync, remoteTree };
}

test("the CLI's Sync reads local from epicenter.json and pushes no audio without a .gitignore", async () => {
	const folder = await desktopFolder();
	await folder.write('epicenter.json', formatDefinition(definition));
	await folder.write('recordings/x.md', '---\ntitle: X\n---\n');
	await folder.write('audio/x.wav', 'RIFF');
	await folder.sync();
	expect(await folder.remoteTree()).toEqual([
		'epicenter.json',
		'recordings/x.md',
	]);
	expect(await readFile(join(folder.directory, 'audio/x.wav'), 'utf8')).toBe(
		'RIFF',
	);
});

test("the CLI's Sync untracks audio committed before epicenter.json declared it local, and keeps the file", async () => {
	const folder = await desktopFolder();
	await folder.write(
		'epicenter.json',
		formatDefinition(defineFolder({ tables })),
	);
	await folder.write('recordings/x.md', '---\ntitle: X\n---\n');
	await folder.write('audio/x.wav', 'RIFF');
	await folder.sync();
	expect(await folder.remoteTree()).toContain('audio/x.wav');

	await folder.write('epicenter.json', formatDefinition(definition));
	await folder.sync();
	expect(await folder.remoteTree()).toEqual([
		'epicenter.json',
		'recordings/x.md',
	]);
	expect(await git(folder.directory, 'ls-files', 'audio')).toBe('');
	expect(await readFile(join(folder.directory, 'audio/x.wav'), 'utf8')).toBe(
		'RIFF',
	);
});

test('the CLI refuses to save or sync when epicenter.json cannot be used, and pushes nothing', async () => {
	const folder = await desktopFolder();
	await folder.write(
		'epicenter.json',
		formatDefinition(defineFolder({ tables })),
	);
	await folder.write('recordings/x.md', '---\ntitle: X\n---\n');
	await folder.write('audio/x.wav', 'RIFF');
	await folder.sync();
	const pushed = await git(folder.directory, 'rev-parse', 'origin/main');

	// A local list prepare refuses: a negation re-includes instead of keeping.
	const declared = JSON.parse(formatDefinition(definition));
	await folder.write(
		'epicenter.json',
		JSON.stringify({ ...declared, local: ['!audio/'] }),
	);
	await folder.write('audio/x.wav', 'RIFF, longer now');
	for (const request of [
		{ op: 'sync' } as const,
		{ op: 'saveVersion', message: 'Keep this' } as const,
	])
		await expect(
			runHistory(folder.directory, request, { author }),
		).rejects.toThrow('epicenter.json cannot be used');
	const bare = join(folder.directory, '..', 'remote.git');
	expect(await git(bare, 'rev-parse', 'main')).toBe(pushed);
	expect(await git(folder.directory, 'rev-parse', 'HEAD')).toBe(pushed);
	// Reading still works.
	const status = await runHistory(
		folder.directory,
		{ op: 'status' },
		{ author },
	);
	expect((status.result as { error: unknown }).error).toBeNull();
});
