/**
 * Folder Setup Tests
 *
 * Runs `setUpFolder` against real directories and the real `git`, through
 * the folder package's directory opener. The folder is opened first, as the
 * desktop leaf opens it first; setup is the only thing between opening and
 * showing the notes.
 *
 * Key behaviors:
 * - Opening writes nothing; setup's first write publishes discovery JSON, so
 *   a folder that needs no setup is left exactly as it was
 * - Existing notes and ordinary files, an earlier build's `kv.json` among
 *   them, are preserved, and setup writes no `kv.json`
 * - A missing layout is created; setup records no commit (ADR-0529)
 * - A table directory another writer made after the look is kept, and a
 *   refusal is reported without retrying
 */
import { afterEach, describe, expect, setDefaultTimeout, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import {
	mkdir,
	mkdtemp,
	readdir,
	readFile,
	realpath,
	rm,
	stat,
	writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { formatDeclaration, openFolder } from '@epicenter/folder/bun';
import { honeycrispDefinition } from '../data.js';
import { setUpFolder } from './first-open.js';
import { HONEYCRISP_FOLDER_ID, type NotesFolder } from './types.js';

// Real git processes; generous under a loaded machine.
setDefaultTimeout(60_000);

const TABLES = Object.keys(honeycrispDefinition.tables);
const cleanup: (() => Promise<void>)[] = [];

afterEach(async () => {
	for (const close of cleanup.splice(0).reverse()) await close();
});

async function directory() {
	// Honeycrisp's own folder, named after it.
	const parent = await realpath(
		await mkdtemp(join(tmpdir(), 'honeycrisp-setup-')),
	);
	const root = join(parent, HONEYCRISP_FOLDER_ID);
	await mkdir(root);
	cleanup.push(() => rm(parent, { recursive: true, force: true }));
	const git = (...args: string[]) =>
		spawnSync('git', args, { cwd: root, encoding: 'utf8' });
	return { root, git };
}

async function open(root: string) {
	const opened = await openFolder({
		root,
		app: HONEYCRISP_FOLDER_ID,
		definition: honeycrispDefinition,
		git: { author: { name: 'Honeycrisp', email: 'honeycrisp@localhost' } },
	});
	if (opened.error) throw new Error(opened.error.message);
	const folder = opened.data;
	cleanup.push(() => folder.close());
	return folder;
}

/** Every file under `directory` with its size and modification time. */
async function fingerprint(directory: string): Promise<string[]> {
	const lines: string[] = [];
	for (const entry of await readdir(directory, {
		recursive: true,
		withFileTypes: true,
	})) {
		const path = join(entry.parentPath, entry.name);
		const stats = await stat(path);
		lines.push(
			entry.isDirectory()
				? `${path}/`
				: `${path} ${stats.size} ${stats.mtimeMs}`,
		);
	}
	return lines.sort();
}

const NOTE =
	'---\r\ntitle:   "Spaced"  # keep\r\nextra: [1, 2]\r\n---\r\n\r\n* a\r\n';
const KV = '{"kept":true}';

/** A folder someone already has: a note, an earlier build's `kv.json`, and both table directories. */
async function existing() {
	const { root, git } = await directory();
	for (const table of TABLES) await mkdir(join(root, table));
	await writeFile(join(root, 'notes', 'old.md'), NOTE);
	await writeFile(join(root, 'kv.json'), KV);
	return { root, git };
}

// ============================================================================
// Opening an existing folder
// ============================================================================

describe('an existing folder', () => {
	test('with history and nothing missing is left exactly as it was: no definition, no commit', async () => {
		const { root, git } = await existing();
		git('init', '--quiet', '--initial-branch=main');
		git('add', '--all');
		const committed = git(
			'-c',
			'user.name=Someone',
			'-c',
			'user.email=someone@example.com',
			'-c',
			'commit.gpgsign=false',
			'commit',
			'--quiet',
			'--message',
			'Their own first commit',
		);
		expect(committed.status).toBe(0);
		const prior = git('rev-parse', 'HEAD').stdout.trim();
		const savedFiles = async () =>
			(await fingerprint(root)).filter((line) => !line.includes('/.git'));
		const before = await savedFiles();
		const folder = await open(root);
		await setUpFolder(folder.files, TABLES);
		// Setup found nothing to write, so the definition was never published.
		expect(await savedFiles()).toEqual(before);
		expect(git('rev-parse', 'HEAD').stdout.trim()).toBe(prior);
		expect(git('status', '--porcelain').stdout).toBe('');
		expect(await Bun.file(join(root, 'epicenter.json')).exists()).toBe(false);
		expect(await readFile(join(root, 'notes', 'old.md'), 'utf8')).toBe(NOTE);
		expect(await readFile(join(root, 'kv.json'), 'utf8')).toBe(KV);
	});

	test('with an unborn repository keeps existing content intact and records no commit', async () => {
		const { root, git } = await existing();
		git('init', '--quiet', '--initial-branch=main');
		const files = (await fingerprint(root)).filter(
			(line) => !line.includes('/.git'),
		);
		const folder = await open(root);
		await setUpFolder(folder.files, TABLES);
		expect(git('rev-parse', '--verify', '--quiet', 'HEAD').status).not.toBe(0);
		expect(
			(await fingerprint(root)).filter((line) => !line.includes('/.git')),
		).toEqual(files);
	});

	test('missing one table directory gains it and the definition while saved content stays intact', async () => {
		const { root, git } = await directory();
		await mkdir(join(root, 'notes'));
		await writeFile(join(root, 'notes', 'old.md'), NOTE);
		await writeFile(join(root, 'kv.json'), KV);
		const kept = [
			await stat(join(root, 'notes', 'old.md')),
			await stat(join(root, 'kv.json')),
		].map((stats) => stats.mtimeMs);
		const folder = await open(root);
		await setUpFolder(folder.files, TABLES);
		expect((await stat(join(root, 'folders'))).isDirectory()).toBe(true);
		// Making the directory was the first write, so it published the definition.
		expect(await readFile(join(root, 'epicenter.json'), 'utf8')).toBe(
			formatDeclaration(honeycrispDefinition),
		);
		expect(await readFile(join(root, 'kv.json'), 'utf8')).toBe(KV);
		expect(
			[
				await stat(join(root, 'notes', 'old.md')),
				await stat(join(root, 'kv.json')),
			].map((stats) => stats.mtimeMs),
		).toEqual(kept);
		expect(git('rev-parse', '--verify', '--quiet', 'HEAD').status).not.toBe(0);
	});
});

// ============================================================================
// A new folder
// ============================================================================

describe('a new folder', () => {
	test('gets its table directories and definition and nothing else, and setting up again changes nothing', async () => {
		const { root, git } = await directory();
		const folder = await open(root);
		await setUpFolder(folder.files, TABLES);
		for (const table of TABLES)
			expect((await stat(join(root, table))).isDirectory()).toBe(true);
		expect(
			(await readdir(root)).filter((name) => name !== '.git').sort(),
		).toEqual(['epicenter.json', ...TABLES].sort());
		expect(await readFile(join(root, 'epicenter.json'), 'utf8')).toBe(
			formatDeclaration(honeycrispDefinition),
		);
		// Setting up again writes nothing, so even epicenter.json is untouched.
		const files = await fingerprint(root);
		const reopened = await open(root);
		await setUpFolder(reopened.files, TABLES);
		expect(await fingerprint(root)).toEqual(files);
		expect(git('rev-parse', '--verify', '--quiet', 'HEAD').status).not.toBe(0);
	});
});

// ============================================================================
// Races and refusals
// ============================================================================

describe('races and refusals', () => {
	test('a table directory another writer made after the look is kept', async () => {
		const { root } = await directory();
		const folder = await open(root);
		await setUpFolder(
			{
				async list() {
					const listed = await folder.files.list();
					// The other writer lands between the look and the mkdir.
					await mkdir(join(root, 'notes'));
					await writeFile(join(root, 'notes', 'old.md'), NOTE);
					return listed;
				},
				mkdir: (path) => folder.files.mkdir(path),
			},
			TABLES,
		);
		expect(await readFile(join(root, 'notes', 'old.md'), 'utf8')).toBe(NOTE);
		expect((await stat(join(root, 'folders'))).isDirectory()).toBe(true);
	});

	/** A files surface that answers from fixed results and records its mkdirs. */
	function scripted(results: {
		mkdir?: { name: string; message: string } | null;
	}) {
		const calls = { mkdir: [] as string[] };
		const files = {
			list: async () => ({
				data: { files: [], directories: ['notes'] },
				error: null,
			}),
			mkdir: async (path: string) => {
				calls.mkdir.push(path);
				const error = results.mkdir ?? null;
				return error === null
					? { data: undefined, error: null }
					: { data: null, error };
			},
		} as unknown as NotesFolder['files'];
		return { files, calls };
	}

	test('a table directory that cannot be made is reported and not tried again', async () => {
		const { files, calls } = scripted({
			mkdir: { name: 'Io', message: 'Read-only file system' },
		});
		await expect(setUpFolder(files, TABLES)).rejects.toThrow(
			'The notes folder could not be set up: Read-only file system',
		);
		// Only the missing table was attempted; `notes` was already listed.
		expect(calls.mkdir).toEqual(['folders']);
	});

	test('a folder that cannot be listed is not changed', async () => {
		const { files, calls } = scripted({});
		files.list = async () =>
			({
				data: null,
				error: { name: 'Io', message: 'Permission denied' },
			}) as unknown as Awaited<ReturnType<NotesFolder['files']['list']>>;
		await expect(setUpFolder(files, TABLES)).rejects.toThrow(
			'Permission denied',
		);
		expect(calls.mkdir).toEqual([]);
	});
});
