/**
 * Local Declaration Tests
 *
 * The desktop's Sync and Save version run in the `epicenter` CLI
 * (`runHistory`), which reads the folder's definition from its own
 * `epicenter.json`. So `local` lives in that file, and the CLI leaves the
 * paths it names out of every commit with no `.gitignore` to help.
 *
 * Key behaviors:
 * - `formatDefinition` writes `local`, and `parseDeclaration` and
 *   `readDefinition` read it back; a declaration without it stays valid
 * - A declared pattern that cannot be a `.gitignore` line is refused on read
 * - `local` is sorted and kept once each, so the declaration's bytes do not
 *   depend on the order it was written in
 * - `runHistory`'s sync, with `epicenter.json` declaring `audio/` and no
 *   `.gitignore`, pushes no audio; a WAV committed earlier is untracked and
 *   kept on disk
 * - A folder with no `epicenter.json` refuses a save version and a sync with
 *   an actionable error before any commit, while status and the log still
 *   read, and refusing declares nothing
 * - A saved version leaves out declared-local audio, tracked earlier or not
 * - `{"local": ["audio/"]}` alone, or beside tables no app can prepare, is a
 *   whole policy: a save version and a sync keep audio out and leave the
 *   file's bytes as written; `{"tables": {}}` keeps nothing local
 * - An `epicenter.json` whose `local` cannot be used refuses a save version
 *   and a sync before any repository, commit, or push, and changes no file;
 *   status and the log still read
 * - A rule the remote's `epicenter.json` newly declares keeps the remote's
 *   tracked audio off disk, and out of the merge Sync makes
 * - Sync sends no commit the remote lacks that adds or changes a path a rule
 *   seen keeps local, though the latest tree is clean: not a version saved
 *   before the rule, and not a checkpoint made before the fetch that brought
 *   it. It names the commit and the path, and rewrites nothing
 * - A rule only the remote removed stops Sync, whether it takes the remote or
 *   merges, every time until a person here removes it too; the file and the
 *   audio stay as they were
 * - A merged `epicenter.json` keeps every rule this folder's file lists and
 *   every one the remote's newly declares, or Sync stops until it does
 * - A remote that removed `epicenter.json` stops Sync, though this folder's
 *   lists nothing local, so the folder keeps the file it needs to record
 */
import { afterAll, afterEach, beforeAll, expect, test } from 'bun:test';
import { existsSync } from 'node:fs';
import { mkdir, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { expectErr, expectOk } from 'wellcrafted/testing';
import {
	defineFolder,
	defineTable,
	field,
	type HistoryRequest,
	runHistory,
} from './bun.js';
import { formatDefinition, parseDeclaration } from './declaration.js';
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
/** The whole policy a Whispering folder needs, as the CLI suggests it. */
const POLICY = '{"local": ["audio/"]}';
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
	expect(expectOk(parseDeclaration(text)).local).toEqual(['audio/']);
	// Its bytes change with `local`, so publishing writes the new list.
	expect(formatDefinition(defineFolder({ tables }))).not.toBe(text);
	expect(
		expectOk(parseDeclaration(formatDefinition(defineFolder({ tables }))))
			.local,
	).toBeUndefined();
});

test('a declared local that is not .gitignore lines is refused when read', () => {
	const declared = JSON.parse(formatDefinition(definition));
	const text = (local: unknown) => JSON.stringify({ ...declared, local });
	for (const local of ['audio/', [3]])
		expect(parseDeclaration(text(local)).error?.reason).toContain('local');
	for (const local of [['!audio/x.wav'], ['# audio'], [' audio/']]) {
		expect(expectErr(parseDeclaration(text(local))).reason).toContain(
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
	const read = expectOk(parseDeclaration(formatDefinition(repeated)));
	expect(read.local).toEqual(['audio/', 'drafts/']);
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
	return { directory, bare, write, sync, remoteTree };
}

/** Every file and directory under `directory` but `.git`, with each file's bytes. */
async function contents(directory: string) {
	const found: Record<string, string> = {};
	for (const entry of await readdir(directory, {
		recursive: true,
		withFileTypes: true,
	})) {
		const path = join(entry.parentPath, entry.name).slice(directory.length + 1);
		if (path === '.git' || path.startsWith('.git/')) continue;
		found[path] = entry.isFile()
			? (await readFile(join(directory, path))).toString('base64')
			: 'directory';
	}
	return found;
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

test('a remote edit to tracked audio stays off disk after the folder declares it local', async () => {
	const folder = await desktopFolder();
	await folder.write(
		'epicenter.json',
		formatDefinition(defineFolder({ tables })),
	);
	await folder.write('audio/x.wav', 'RIFF local');
	await folder.sync();
	const other = join(folder.directory, '..', 'other');
	await git(folder.directory, 'clone', '--quiet', '../remote.git', other);
	await writeFile(join(other, 'audio/x.wav'), 'RIFF remote');
	await git(other, 'add', '--all');
	await git(other, 'commit', '--quiet', '-m', 'Change tracked audio');
	await git(other, 'push', '--quiet', 'origin', 'main');
	await folder.write('epicenter.json', formatDefinition(definition));
	await folder.sync();
	expect(await readFile(join(folder.directory, 'audio/x.wav'), 'utf8')).toBe(
		'RIFF local',
	);
	expect(await folder.remoteTree()).not.toContain('audio/x.wav');
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

test('a folder with no epicenter.json refuses to save a version or sync, commits and pushes nothing, and still reads', async () => {
	// A fresh Whispering folder: a row and its audio, and no declaration.
	const folder = await desktopFolder();
	await folder.write('recordings/take.md', '---\ntitle: Take\n---\n');
	await folder.write('audio/take.wav', 'RIFF');
	for (const request of [
		{ op: 'saveVersion', message: 'Keep this' } as const,
		{ op: 'sync' } as const,
		{ op: 'sync', connect: 'https://example.test/x.git' } as const,
	]) {
		const refusal = await runHistory(folder.directory, request, {
			author,
		}).then(
			() => undefined,
			(error: Error) => error.message,
		);
		expect(refusal).toContain('has no epicenter.json');
		expect(refusal).toContain('nothing was committed');
		expect(refusal).toContain('{"local": ["audio/"]}');
	}
	// Nothing was committed or pushed, and every file is still on disk.
	expect(await git(folder.directory, 'rev-list', '--all')).toBe('');
	expect(await git(folder.directory, 'ls-files')).toBe('');
	expect(await git(folder.directory, 'ls-remote', 'origin')).toBe('');
	expect(await readFile(join(folder.directory, 'audio/take.wav'), 'utf8')).toBe(
		'RIFF',
	);
	// Refusing declared nothing.
	await expect(
		readFile(join(folder.directory, 'epicenter.json')),
	).rejects.toThrow();
	// Status and the log still read the folder.
	for (const request of [
		{ op: 'status' } as const,
		{ op: 'log', depth: 5 } as const,
	]) {
		const reply = await runHistory(folder.directory, request, { author });
		expect((reply.result as { error: unknown }).error).toBeNull();
	}
});

test('a saved version leaves out audio an epicenter.json declares local, even audio an earlier version tracked', async () => {
	const folder = await desktopFolder();
	await folder.write(
		'epicenter.json',
		formatDefinition(defineFolder({ tables })),
	);
	await folder.write('recordings/take.md', '---\ntitle: Take\n---\n');
	await folder.write('audio/take.wav', 'RIFF');
	const saveVersion = () =>
		runHistory(folder.directory, { op: 'saveVersion' }, { author });
	expect((await saveVersion()).result).toMatchObject({ status: 'committed' });
	expect(await git(folder.directory, 'ls-files', 'audio')).toBe(
		'audio/take.wav',
	);

	await folder.write('epicenter.json', formatDefinition(definition));
	await folder.write('audio/take.wav', 'RIFF, longer now');
	await folder.write('audio/other.wav', 'RIFF');
	expect((await saveVersion()).result).toMatchObject({ status: 'committed' });
	expect(await git(folder.directory, 'ls-files', 'audio')).toBe('');
	expect(
		await git(folder.directory, 'ls-tree', '-r', '--name-only', 'HEAD'),
	).not.toContain('audio/');
	expect(await readFile(join(folder.directory, 'audio/take.wav'), 'utf8')).toBe(
		'RIFF, longer now',
	);
});

for (const [name, text] of [
	['alone', POLICY],
	[
		'beside a table no app can prepare',
		'{"local":["audio/"],"tables":{"takes":{"type":"string"}}}',
	],
	[
		'beside tables that are not a map',
		'{\n  "local": ["audio/"],\n  "tables": []\n}',
	],
] as const)
	test(`local ${name} keeps tracked and untracked audio out of a save version and a sync, and its bytes stay as written`, async () => {
		const folder = await desktopFolder();
		// Audio plain Git tracked and pushed before the folder declared it.
		await folder.write('audio/old.wav', 'RIFF old');
		await git(folder.directory, 'add', '--all');
		await git(folder.directory, 'commit', '--quiet', '-m', 'Audio');
		await git(folder.directory, 'push', '--quiet', 'origin', 'main');
		await folder.write('epicenter.json', text);
		await folder.write('recordings/new.md', '---\ntitle: New\n---\n');
		await folder.write('audio/new.wav', 'RIFF new');
		const saved = await runHistory(
			folder.directory,
			{ op: 'saveVersion' },
			{ author },
		);
		expect(saved.result).toMatchObject({ status: 'committed' });
		expect(await git(folder.directory, 'ls-files')).toBe(
			'epicenter.json\nrecordings/new.md',
		);
		await folder.sync();
		expect(await folder.remoteTree()).toEqual([
			'epicenter.json',
			'recordings/new.md',
		]);
		// No commit the remote holds carries the new audio.
		expect(
			await git(folder.bare, 'log', '--all', '--format=', '--name-only'),
		).not.toContain('audio/new.wav');
		for (const [path, bytes] of [
			['audio/old.wav', 'RIFF old'],
			['audio/new.wav', 'RIFF new'],
			['epicenter.json', text],
		] as const)
			expect(await readFile(join(folder.directory, path), 'utf8')).toBe(bytes);
		expect(await git(folder.directory, 'show', 'HEAD:epicenter.json')).toBe(
			text,
		);
	});

test('an epicenter.json of only tables keeps nothing local', async () => {
	const folder = await desktopFolder();
	await folder.write('epicenter.json', '{"tables":{}}');
	await folder.write('audio/take.wav', 'RIFF');
	const saved = await runHistory(
		folder.directory,
		{ op: 'saveVersion' },
		{ author },
	);
	expect(saved.result).toMatchObject({ status: 'committed' });
	expect(await git(folder.directory, 'ls-files')).toBe(
		'audio/take.wav\nepicenter.json',
	);
});

for (const [name, declared] of [
	['a directory in its place', 'directory'],
	['bytes that are not UTF-8', new Uint8Array([0xff, 0xfe, 0x7b, 0x7d])],
	['text that is not JSON', '{"local": ["audio/"]'],
	['a misspelled Local', '{"Local": ["audio/"]}'],
	['an unknown key', '{"local": ["audio/"], "locals": []}'],
	['a negation', '{"local": ["audio/", "!audio/keep.wav"]}'],
	['a comment', '{"local": ["# audio/"]}'],
	['an empty pattern', '{"local": [""]}'],
	['a pattern of two lines', '{"local": ["audio/\\nrecordings/"]}'],
	['surrounding whitespace', '{"local": ["audio/ "]}'],
	['a pattern that is not a string', '{"local": [["audio/"]]}'],
	['a pattern that keeps itself local', '{"local": ["audio/", "*.json"]}'],
] as const)
	test(`an epicenter.json with ${name} refuses to save or sync before any repository, commit, or push, and changes no file`, async () => {
		const root = await scratch('local-unusable-');
		roots.push(root);
		const bare = join(root, 'remote.git');
		await git(root, 'init', '--quiet', '--bare', '--initial-branch=main', bare);
		const directory = join(root, 'folder');
		await mkdir(join(directory, 'audio'), { recursive: true });
		await mkdir(join(directory, 'recordings'));
		await writeFile(
			join(directory, 'recordings/take.md'),
			'---\ntitle: Take\n---\n',
		);
		await writeFile(join(directory, 'audio/take.wav'), 'RIFF');
		if (declared === 'directory')
			await mkdir(join(directory, 'epicenter.json'));
		else await writeFile(join(directory, 'epicenter.json'), declared);
		const before = await contents(directory);
		const refuses = (request: HistoryRequest) =>
			expect(runHistory(directory, request, { author })).rejects.toThrow(
				'epicenter.json cannot be used, so nothing was committed',
			);
		// With no repository yet, refusing makes none.
		await refuses({ op: 'saveVersion', message: 'Keep this' });
		await refuses({ op: 'sync', connect: 'https://example.test/x.git' });
		expect(existsSync(join(directory, '.git'))).toBe(false);
		// With a repository and a remote, nothing is committed or pushed.
		await initWithOrigin(directory, bare);
		await refuses({ op: 'saveVersion' });
		await refuses({ op: 'sync' });
		expect(await git(directory, 'rev-list', '--all')).toBe('');
		expect(await git(bare, 'rev-list', '--all')).toBe('');
		expect(await contents(directory)).toEqual(before);
		for (const request of [
			{ op: 'status' } as const,
			{ op: 'log', depth: 5 } as const,
		]) {
			const reply = await runHistory(directory, request, { author });
			expect((reply.result as { error: unknown }).error).toBeNull();
		}
	});

/**
 * A synced folder whose `epicenter.json` keeps nothing local, and a plain Git
 * clone of its remote where another device declares `audio/` local in a
 * commit that still tracks `audio/remote.wav`.
 */
async function remoteDeclaresAudio() {
	const folder = await desktopFolder();
	await folder.write('epicenter.json', '{"tables":{}}');
	await folder.write('recordings/x.md', '---\ntitle: X\n---\n');
	await folder.sync();
	const other = join(folder.directory, '..', 'other');
	await git(folder.directory, 'clone', '--quiet', '../remote.git', other);
	await writeFile(join(other, 'epicenter.json'), POLICY);
	await mkdir(join(other, 'audio'));
	await writeFile(join(other, 'audio/remote.wav'), 'RIFF remote');
	await git(other, 'add', '--all');
	await git(other, 'commit', '--quiet', '-m', 'Keep audio local');
	await git(other, 'push', '--quiet', 'origin', 'main');
	return folder;
}

test("audio a remote revision newly declares local is not written here when Sync takes the remote's tree", async () => {
	const folder = await remoteDeclaresAudio();
	await folder.sync();
	expect(await readFile(join(folder.directory, 'epicenter.json'), 'utf8')).toBe(
		POLICY,
	);
	expect(existsSync(join(folder.directory, 'audio/remote.wav'))).toBe(false);
	// The remote's own commit tracks it; the next version here does not.
	const saved = await runHistory(
		folder.directory,
		{ op: 'saveVersion' },
		{ author },
	);
	expect(saved.result).toMatchObject({ status: 'committed' });
	expect(await git(folder.directory, 'ls-files')).toBe(
		'epicenter.json\nrecordings/x.md',
	);
	expect(existsSync(join(folder.directory, 'audio/remote.wav'))).toBe(false);
});

test('audio a remote revision newly declares local stays out of the merge Sync makes, and off disk', async () => {
	const folder = await remoteDeclaresAudio();
	await folder.write('recordings/y.md', '---\ntitle: Y\n---\n');
	await folder.sync();
	expect(
		(await git(folder.directory, 'log', '-1', '--format=%P')).split(' '),
	).toHaveLength(2);
	expect(
		await git(folder.directory, 'ls-tree', '-r', '--name-only', 'HEAD'),
	).toBe('epicenter.json\nrecordings/x.md\nrecordings/y.md');
	expect(await folder.remoteTree()).toEqual([
		'epicenter.json',
		'recordings/x.md',
		'recordings/y.md',
	]);
	expect(existsSync(join(folder.directory, 'audio/remote.wav'))).toBe(false);
	expect(await readFile(join(folder.directory, 'epicenter.json'), 'utf8')).toBe(
		POLICY,
	);
});

/** A Sync that stopped, and why, as the CLI's reply carries it. */
async function blockedSync(directory: string) {
	const reply = await runHistory(directory, { op: 'sync' }, { author });
	const { error } = reply.result as {
		error: { name: string; reason: string } | null;
	};
	expect(error?.name).toBe('Blocked');
	return error?.reason ?? '';
}

/** Another device: a plain Git clone of `folder`'s remote that commits files and pushes them. */
async function otherDevice(folder: { directory: string }) {
	const other = join(folder.directory, '..', 'other');
	await git(folder.directory, 'clone', '--quiet', '../remote.git', other);
	return async (files: Record<string, string>, message: string) => {
		for (const [path, text] of Object.entries(files)) {
			await mkdir(join(other, path, '..'), { recursive: true });
			await writeFile(join(other, path), text);
		}
		await git(other, 'add', '--all');
		await git(other, 'commit', '--quiet', '-m', message);
		await git(other, 'push', '--quiet', 'origin', 'main');
	};
}

test('Sync sends no unsent version that carries audio epicenter.json now keeps local, though the latest is clean, and rewrites nothing', async () => {
	const folder = await desktopFolder();
	await folder.write('epicenter.json', '{"tables":{}}');
	await folder.write('recordings/x.md', '---\ntitle: X\n---\n');
	await folder.sync();
	const pushed = await git(folder.bare, 'rev-parse', 'main');
	// Saved before the rule, and not yet sent: this version carries audio.
	await folder.write('audio/take.wav', 'RIFF');
	const saved = await runHistory(
		folder.directory,
		{ op: 'saveVersion' },
		{ author },
	);
	expect(saved.result).toMatchObject({ status: 'committed' });
	const carrier = await git(folder.directory, 'rev-parse', 'HEAD');
	await folder.write('epicenter.json', POLICY);
	for (let invocation = 0; invocation < 2; invocation++) {
		const reason = await blockedSync(folder.directory);
		expect(reason).toContain(`commit ${carrier} adds 'audio/take.wav'`);
		expect(await git(folder.bare, 'rev-parse', 'main')).toBe(pushed);
		// The version the rule made is clean; the one before it is as it was.
		expect(
			await git(folder.directory, 'ls-tree', '-r', '--name-only', 'HEAD'),
		).toBe('epicenter.json\nrecordings/x.md');
		expect(await git(folder.directory, 'rev-parse', 'HEAD~1')).toBe(carrier);
		expect(
			await readFile(join(folder.directory, 'audio/take.wav'), 'utf8'),
		).toBe('RIFF');
		expect(
			await readFile(join(folder.directory, 'epicenter.json'), 'utf8'),
		).toBe(POLICY);
	}
});

test('audio a checkpoint recorded before the remote newly declared it local is not sent with the merge', async () => {
	const folder = await desktopFolder();
	await folder.write('epicenter.json', '{"tables":{}}');
	await folder.write('recordings/x.md', '---\ntitle: X\n---\n');
	await folder.sync();
	const synced = await git(folder.directory, 'rev-parse', 'HEAD');
	const other = await otherDevice(folder);
	await other({ 'epicenter.json': POLICY }, 'Keep audio local');
	const declared = await git(folder.bare, 'rev-parse', 'main');
	// This Sync's checkpoint records it before its fetch sees the rule.
	await folder.write('audio/mine.wav', 'RIFF mine');
	const reason = await blockedSync(folder.directory);
	const checkpoint = await git(folder.directory, 'rev-parse', 'HEAD');
	expect(reason).toContain(`commit ${checkpoint} adds 'audio/mine.wav'`);
	expect(await git(folder.bare, 'rev-parse', 'main')).toBe(declared);
	expect(
		await git(folder.bare, 'log', '--all', '--format=', '--name-only'),
	).not.toContain('audio/mine.wav');
	// Nothing here was published or rewritten: the branch holds the
	// checkpoint over the last Sync, and the files are as they were.
	expect(await git(folder.directory, 'rev-parse', 'HEAD~1')).toBe(synced);
	expect(await readFile(join(folder.directory, 'audio/mine.wav'), 'utf8')).toBe(
		'RIFF mine',
	);
	expect(await readFile(join(folder.directory, 'epicenter.json'), 'utf8')).toBe(
		'{"tables":{}}',
	);
});

for (const [name, editHere] of [
	['takes the remote', false],
	['merges with the remote', true],
] as const)
	test(`a rule only the remote removed stops a Sync that ${name}, the next one too, until a person here removes it`, async () => {
		const folder = await desktopFolder();
		await folder.write('epicenter.json', POLICY);
		await folder.write('recordings/x.md', '---\ntitle: X\n---\n');
		await folder.write('audio/x.wav', 'RIFF');
		await folder.sync();
		const other = await otherDevice(folder);
		await other({ 'epicenter.json': '{"tables":{}}' }, 'Share audio');
		const removal = await git(folder.bare, 'rev-parse', 'main');
		if (editHere) await folder.write('recordings/y.md', '---\ntitle: Y\n---\n');
		let head: string | undefined;
		for (let invocation = 0; invocation < 2; invocation++) {
			const reason = await blockedSync(folder.directory);
			expect(reason).toContain(
				"the remote's epicenter.json no longer keeps 'audio/' on each computer",
			);
			expect(reason).toContain(
				`remove 'audio/' from "local" in this folder's epicenter.json`,
			);
			const now = await git(folder.directory, 'rev-parse', 'HEAD');
			expect(head ?? now).toBe(now);
			head = now;
			expect(await git(folder.bare, 'rev-parse', 'main')).toBe(removal);
			expect(
				await readFile(join(folder.directory, 'epicenter.json'), 'utf8'),
			).toBe(POLICY);
			expect(
				await readFile(join(folder.directory, 'audio/x.wav'), 'utf8'),
			).toBe('RIFF');
			expect(
				await git(folder.directory, 'ls-tree', '-r', '--name-only', 'HEAD'),
			).not.toContain('audio/');
		}
		// Removed here as well, the audio is shared, as both files now say.
		await folder.write('epicenter.json', '{"tables":{}}');
		await folder.sync();
		expect(await folder.remoteTree()).toEqual([
			'audio/x.wav',
			'epicenter.json',
			'recordings/x.md',
			...(editHere ? ['recordings/y.md'] : []),
		]);
	});

test('a policy both devices changed merges only once it keeps every rule of each, and the next Sync stops until then', async () => {
	const folder = await desktopFolder();
	await folder.write('epicenter.json', POLICY);
	await folder.write('recordings/x.md', '---\ntitle: X\n---\n');
	await folder.sync();
	const other = await otherDevice(folder);
	await other(
		{ 'epicenter.json': '{"local": ["audio/", "drafts/"]}' },
		'Keep drafts local',
	);
	const remoteHead = await git(folder.bare, 'rev-parse', 'main');
	// Both sides changed the one line; this device's wins it, dropping drafts/.
	const mine = '{"local": ["audio/", "notes/"]}';
	await folder.write('epicenter.json', mine);
	await folder.write('notes/n.md', 'mine');
	for (let invocation = 0; invocation < 2; invocation++) {
		const reason = await blockedSync(folder.directory);
		expect(reason).toContain(`merging would drop 'drafts/' from "local"`);
		expect(reason).toContain(
			`Add 'drafts/' to "local" in this folder's epicenter.json`,
		);
		expect(await git(folder.bare, 'rev-parse', 'main')).toBe(remoteHead);
		expect(
			await readFile(join(folder.directory, 'epicenter.json'), 'utf8'),
		).toBe(mine);
		expect(await readFile(join(folder.directory, 'notes/n.md'), 'utf8')).toBe(
			'mine',
		);
		expect(
			await git(folder.directory, 'ls-tree', '-r', '--name-only', 'HEAD'),
		).toBe('epicenter.json\nrecordings/x.md');
	}
	const both = '{"local": ["audio/", "drafts/", "notes/"]}';
	await folder.write('epicenter.json', both);
	await folder.sync();
	expect(await git(folder.bare, 'show', 'main:epicenter.json')).toBe(both);
	expect(await folder.remoteTree()).toEqual([
		'epicenter.json',
		'recordings/x.md',
	]);
	expect(await readFile(join(folder.directory, 'notes/n.md'), 'utf8')).toBe(
		'mine',
	);
});

for (const [name, editHere] of [
	['takes the remote', false],
	['merges with the remote', true],
] as const)
	test(`a remote that removed epicenter.json stops a Sync that ${name}, though this folder's lists nothing local, until the remote has it again`, async () => {
		const folder = await desktopFolder();
		const policy = '{"local": []}';
		await folder.write('epicenter.json', policy);
		await folder.write('recordings/x.md', '---\ntitle: X\n---\n');
		await folder.sync();
		const other = join(folder.directory, '..', 'other');
		await git(folder.directory, 'clone', '--quiet', '../remote.git', other);
		await git(other, 'rm', '--quiet', 'epicenter.json');
		await git(other, 'commit', '--quiet', '-m', 'Remove the policy');
		await git(other, 'push', '--quiet', 'origin', 'main');
		const removal = await git(folder.bare, 'rev-parse', 'main');
		if (editHere) await folder.write('recordings/y.md', '---\ntitle: Y\n---\n');
		let head: string | undefined;
		for (let invocation = 0; invocation < 2; invocation++) {
			const reason = await blockedSync(folder.directory);
			expect(reason).toContain('the remote removed epicenter.json');
			expect(reason).toContain(
				'Restore epicenter.json on the remote from the device that removed it',
			);
			const now = await git(folder.directory, 'rev-parse', 'HEAD');
			expect(head ?? now).toBe(now);
			head = now;
			expect(await git(folder.bare, 'rev-parse', 'main')).toBe(removal);
			expect(
				await readFile(join(folder.directory, 'epicenter.json'), 'utf8'),
			).toBe(policy);
		}
		// The folder still records here.
		const saved = await runHistory(
			folder.directory,
			{ op: 'saveVersion' },
			{ author },
		);
		expect(saved.result).toMatchObject({ status: 'unchanged' });
		// Restored on the remote, as the refusal says, Sync goes on.
		await writeFile(join(other, 'epicenter.json'), policy);
		await git(other, 'add', 'epicenter.json');
		await git(other, 'commit', '--quiet', '-m', 'Restore the policy');
		await git(other, 'push', '--quiet', 'origin', 'main');
		await folder.sync();
		expect(await folder.remoteTree()).toEqual([
			'epicenter.json',
			'recordings/x.md',
			...(editHere ? ['recordings/y.md'] : []),
		]);
		expect(
			await readFile(join(folder.directory, 'epicenter.json'), 'utf8'),
		).toBe(policy);
	});
