/**
 * Local Declaration Tests
 *
 * What stays on one machine is the folder's `.gitignore` alone (ADR-0592).
 * A definition may still declare `local`, lines an app's own handle adds to
 * `.gitignore` before its first write, but no file in the folder carries it:
 * a table's `.epicenter.json` is its schema alone, and a root
 * `epicenter.json` is an ordinary file nothing reads. So the desktop's Sync
 * and Save version, which run in the `epicenter` CLI (`runHistory`), read
 * no schema at all.
 *
 * Key behaviors:
 * - `formatDefinition` writes one schema file per table and no `local`; a
 *   schema file that declares `local` is refused when read
 * - `local` is sorted and kept once each in the prepared definition
 * - `runHistory`'s sync, with `.gitignore` naming `audio/`, pushes no audio
 * - A root `epicenter.json` listing `local` keeps nothing local and is
 *   committed like any file
 * - A schema file that cannot be used does not stop a save version or a
 *   sync, which read none
 */
import { afterAll, afterEach, beforeAll, expect, test } from 'bun:test';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { expectOk } from 'wellcrafted/testing';
import { runHistory } from './bun.js';
import { defineFolder, defineTable, field } from './contract.js';
import { formatDefinition, parseDefinition } from './declaration.js';
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

const SCHEMA = 'recordings/.epicenter.json';

test('a schema file is one table and carries no local', () => {
	const files = formatDefinition(definition);
	expect(Object.keys(files)).toEqual([SCHEMA]);
	expect(JSON.parse(files[SCHEMA]!)).not.toHaveProperty('local');
	// `local` changes no file, so publishing it writes `.gitignore` alone.
	expect(formatDefinition(defineFolder({ tables }))).toEqual(files);
	const declared = JSON.parse(files[SCHEMA]!);
	expect(
		parseDefinition({
			[SCHEMA]: JSON.stringify({ ...declared, local: ['audio/'] }),
		}).error,
	).toMatchObject({ path: SCHEMA, reason: expect.stringContaining("'local'") });
});

test('a definition keeps local sorted and once each', () => {
	const ordered = defineFolder({
		tables,
		local: ['drafts/', 'audio/'],
	});
	const repeated = defineFolder({
		tables,
		local: ['audio/', 'drafts/', 'audio/'],
	});
	expect(ordered.local).toEqual(['audio/', 'drafts/']);
	expect(repeated.local).toEqual(['audio/', 'drafts/']);
});

/** A folder on disk as the desktop leaves it: a repository with `origin`, and its tables' schema files. */
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

test("the CLI's Sync leaves out what .gitignore names", async () => {
	const folder = await desktopFolder();
	await folder.write(SCHEMA, formatDefinition(definition)[SCHEMA]!);
	await folder.write('.gitignore', 'audio/\n');
	await folder.write('recordings/x.md', '---\ntitle: X\n---\n');
	await folder.write('audio/x.wav', 'RIFF');
	await folder.sync();
	expect(await folder.remoteTree()).toEqual([
		'.gitignore',
		SCHEMA,
		'recordings/x.md',
	]);
	expect(await readFile(join(folder.directory, 'audio/x.wav'), 'utf8')).toBe(
		'RIFF',
	);
});

test("a root epicenter.json is an ordinary file: its local keeps nothing out of the CLI's Sync", async () => {
	const folder = await desktopFolder();
	await folder.write(
		'epicenter.json',
		JSON.stringify({ local: ['audio/'], tables: {} }),
	);
	await folder.write(SCHEMA, formatDefinition(definition)[SCHEMA]!);
	await folder.write('recordings/x.md', '---\ntitle: X\n---\n');
	await folder.write('audio/x.wav', 'RIFF');
	await folder.sync();
	expect(await folder.remoteTree()).toEqual([
		'audio/x.wav',
		'epicenter.json',
		SCHEMA,
		'recordings/x.md',
	]);
});

test('the CLI reads no schema, so one that cannot be used stops neither a save version nor a sync', async () => {
	const folder = await desktopFolder();
	await folder.write(SCHEMA, '{ not json');
	await folder.write('recordings/x.md', '---\ntitle: X\n---\n');
	const saved = await runHistory(
		folder.directory,
		{ op: 'saveVersion', message: 'Keep this' },
		{ author },
	);
	expect(saved.result).toMatchObject({ status: 'committed' });
	await folder.sync();
	expect(await folder.remoteTree()).toEqual([SCHEMA, 'recordings/x.md']);
});
