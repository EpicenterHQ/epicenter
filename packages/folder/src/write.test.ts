/**
 * One Write Tests
 *
 * `folder.write(path, from, to)` reads the file as it is now, merges the
 * change from `from` to `to` into it by unit with `merge`, and puts the
 * result guarded by the hash it read (ADR-0576). `put` is the storage's one
 * conditional change of one file.
 *
 * Key behaviors:
 * - Units only one side changed survive; on a unit both changed, the writer
 *   acting wins, and `overridden` names the unit
 * - Two insertions at one place both survive; identical ones are one
 * - A row is written canonically, except that a row the writer left as it
 *   was is no change, so the other writer's spelling stands
 * - A delete and an edit are the whole file: the writer acting wins either
 *   way, and the other side is overridden
 * - A version that does not read as a row merges as text
 * - `put` lands only while the path holds `ifMatch`, and is `'stale'`
 *   otherwise, changing nothing
 * - A write that loses a race reads and merges again, and gives up as
 *   `KeptChanging` after `WRITE_ATTEMPTS`
 * - A write that changes nothing puts nothing
 * - A delete needs no `from`; a closed folder is `Closed`; a path no file
 *   can be at is `InvalidPath`
 */
import { afterAll, beforeAll, expect, spyOn, test } from 'bun:test';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expectErr, expectOk } from 'wellcrafted/testing';
import { rawBrowserFolder } from './browser-storage.test-support.js';
import { openFolder } from './bun.js';
import {
	defineFolder,
	defineTable,
	field,
	hashBytes,
	WRITE_ATTEMPTS,
} from './contract.js';
import { prepareFolderDefinition } from './definition.js';
import { fileKindOf, merge } from './merge-file.js';
import { writeFile as writeFolderFile } from './save-file.js';

const definition = defineFolder({
	kv: { theme: field.string(), size: field.number() },
	tables: {
		notes: defineTable({
			fields: {
				title: field.string(),
				done: field.boolean(),
				tags: field.optional(field.tags()),
			},
		}),
	},
});
const prepared = expectOk(prepareFolderDefinition(definition));
const ROW = fileKindOf(prepared, 'notes/a.md');
const TEXT = fileKindOf(prepared, 'notes.txt');
const KV = fileKindOf(prepared, 'kv.json');

const row = (frontmatter: string[], body = '') =>
	['---', ...frontmatter, '---', body].join('\n');
const note = (title: string, body = '', done = false) =>
	row([`title: ${title}`, `done: ${done}`], body);

const encoder = new TextEncoder();
const decoder = new TextDecoder();

test('units only one side changed survive, and the writer wins a unit both changed', async () => {
	const merged = await merge(ROW, {
		base: note('Walk', 'one\ntwo\n'),
		ours: note('Evening walk', 'one\ntwo\n', true),
		theirs: note('Run', 'one\ntwo\nthree\n'),
	});
	expect(merged).toEqual({
		content: note('Evening walk', 'one\ntwo\nthree\n', true),
		overridden: [{ kind: 'field', field: 'title' }],
	});
});

test('competing body lines name where the writer’s lines stand', async () => {
	const merged = await merge(ROW, {
		base: note('Walk', 'one\ntwo\nthree\n'),
		ours: note('Walk', 'one\nTWO (ours)\nthree\n'),
		theirs: note('Walk', 'one\nTWO (theirs)\nthree\n'),
	});
	expect(merged).toEqual({
		content: note('Walk', 'one\nTWO (ours)\nthree\n'),
		overridden: [{ kind: 'lines', part: 'body', line: 2 }],
	});
});

test('two appends to one body both survive, and two identical fills are one', async () => {
	expect(
		await merge(ROW, {
			base: note('Walk', 'Notes'),
			ours: note('Walk', 'Notes\nmine'),
			theirs: note('Walk', 'Notes\nyours'),
		}),
	).toEqual({ content: note('Walk', 'Notes\nmine\nyours'), overridden: [] });
	expect(
		await merge(ROW, {
			base: note('Walk'),
			ours: note('Walk', 'The answer.\n'),
			theirs: note('Walk', 'The answer.\n'),
		}),
	).toEqual({ content: note('Walk', 'The answer.\n'), overridden: [] });
});

test('a merged row is written canonically, and a row the writer left alone keeps the other spelling', async () => {
	const handWritten = row([
		'# a comment',
		"title: 'Walk'",
		'done: false',
	]);
	expect(
		await merge(ROW, {
			base: handWritten,
			ours: note('Walk', '', true),
			theirs: handWritten,
		}),
	).toEqual({ content: note('Walk', '', true), overridden: [] });
	expect(
		await merge(ROW, {
			base: note('Walk'),
			ours: note('Walk'),
			theirs: handWritten,
		}),
	).toEqual({ content: handWritten, overridden: [] });
});

test('a delete and an edit are the whole file, and the writer acting wins either way', async () => {
	expect(
		await merge(ROW, {
			base: note('Walk'),
			ours: null,
			theirs: note('Run'),
		}),
	).toEqual({ content: null, overridden: [{ kind: 'file' }] });
	expect(
		await merge(ROW, {
			base: note('Walk'),
			ours: note('Run'),
			theirs: null,
		}),
	).toEqual({ content: note('Run'), overridden: [{ kind: 'file' }] });
	// A delete nobody competed with stands.
	expect(
		await merge(ROW, { base: note('Walk'), ours: note('Walk'), theirs: null }),
	).toEqual({ content: null, overridden: [] });
});

test('a version that does not read as a row merges as text, and binary is the whole file', async () => {
	const broken = '---\ntitle: [unclosed\n---\n';
	expect(
		await merge(ROW, {
			base: note('Walk', 'first\n'),
			ours: broken,
			theirs: note('Walk', 'first\nsecond\n'),
		}),
	).toEqual({ content: `${broken}second\n`, overridden: [] });
	const bytes = (...values: number[]) => new Uint8Array([0, ...values]);
	expect(
		await merge(TEXT, { base: bytes(1), ours: bytes(2), theirs: bytes(3) }),
	).toEqual({ content: bytes(2), overridden: [{ kind: 'file' }] });
});

test('kv.json merges by key, the writer winning a key both set', async () => {
	expect(
		await merge(KV, {
			base: '{"size": 1, "theme": "light"}',
			ours: '{"size": 2, "theme": "dark"}',
			theirs: '{"size": 1, "theme": "blue"}',
		}),
	).toEqual({
		content: '{\n  "size": 2,\n  "theme": "dark"\n}\n',
		overridden: [{ kind: 'setting', key: 'theme' }],
	});
});

test('put lands only while the path holds ifMatch, and changes nothing when stale', async () => {
	const { boundary } = await rawBrowserFolder({ id: 'write.put' });
	const one = encoder.encode('one\n');
	expect(expectOk(await boundary.put('a/b.md', one, null))).toBe('landed');
	expect(expectOk(await boundary.put('a/b.md', one, null))).toBe('stale');
	const first = await hashBytes(one);
	expect(
		expectOk(await boundary.put('a/b.md', encoder.encode('x'), '0'.repeat(64))),
	).toBe('stale');
	expect(
		expectOk(await boundary.put('a/b.md', encoder.encode('two\n'), first)),
	).toBe('landed');
	expect(expectOk(await boundary.put('a/b.md', null, first))).toBe('stale');
	const second = await hashBytes(encoder.encode('two\n'));
	expect(expectOk(await boundary.put('a/b.md', null, second))).toBe('landed');
	expect(expectOk(await boundary.put('a/b.md', null, second))).toBe('stale');
	expect(expectOk(await boundary.put('a/b.md', null, null))).toBe('landed');
	expect(expectErr(await boundary.read('a/b.md')).name).toBe('NotFound');
	expect(expectErr(await boundary.put('.git/x', one, null)).name).toBe(
		'InvalidPath',
	);
});

test('a write that loses a race reads and merges again', async () => {
	const { boundary } = await rawBrowserFolder({ id: 'write.race' });
	expectOk(await boundary.put('notes/a.md', encoder.encode(note('Walk')), null));
	let raced = false;
	const storage = {
		...boundary,
		async put(...args: Parameters<typeof boundary.put>) {
			if (!raced) {
				raced = true;
				const now = expectOk(await boundary.read('notes/a.md'));
				expectOk(
					await boundary.put(
						'notes/a.md',
						encoder.encode(note('Walk', '', true)),
						now.sha256,
					),
				);
			}
			return boundary.put(...args);
		},
	};
	const written = expectOk(
		await writeFolderFile(
			storage,
			ROW,
			'notes/a.md',
			note('Walk'),
			note('Evening walk'),
		),
	);
	expect(decoder.decode(written.file?.bytes)).toBe(
		note('Evening walk', '', true),
	);
	expect(written.overridden).toEqual([]);
});

test('a file that changes on every attempt is KeptChanging, and nothing of the write lands', async () => {
	const { boundary } = await rawBrowserFolder({ id: 'write.kept' });
	expectOk(await boundary.put('n.txt', encoder.encode('0\n'), null));
	let count = 0;
	const storage = {
		...boundary,
		async put(...args: Parameters<typeof boundary.put>) {
			const now = expectOk(await boundary.read('n.txt'));
			expectOk(
				await boundary.put(
					'n.txt',
					encoder.encode(`${++count}\n`),
					now.sha256,
				),
			);
			return boundary.put(...args);
		},
	};
	const error = expectErr(
		await writeFolderFile(storage, TEXT, 'n.txt', '0\n', '0\nmine\n'),
	);
	expect(error).toMatchObject({ name: 'KeptChanging', attempts: WRITE_ATTEMPTS });
	expect(decoder.decode(expectOk(await boundary.read('n.txt')).bytes)).toBe(
		`${WRITE_ATTEMPTS}\n`,
	);
});

const originalEnv = { ...process.env };
const roots: string[] = [];
beforeAll(() => {
	Object.assign(process.env, {
		GIT_CONFIG_GLOBAL: '/dev/null',
		GIT_CONFIG_NOSYSTEM: '1',
	});
});
afterAll(async () => {
	for (const key of ['GIT_CONFIG_GLOBAL', 'GIT_CONFIG_NOSYSTEM'])
		if (originalEnv[key] === undefined) delete process.env[key];
		else process.env[key] = originalEnv[key];
	await Promise.all(roots.map((root) => rm(root, { recursive: true })));
});

/** A directory folder in Bun, which writes under the directory's save lock. */
async function directory() {
	const root = await mkdtemp(join(tmpdir(), 'folder-write-'));
	roots.push(root);
	const folder = expectOk(
		await openFolder({
			root,
			definition,
			git: { author: { name: 'Folders', email: 'folders@localhost' } },
		}),
	);
	const onDisk = (path: string) => readFile(join(root, path), 'utf8');
	return { root, folder, onDisk };
}

test('a create makes the file and its directory, and a second create merges by unit', async () => {
	const { folder, onDisk } = await directory();
	const created = expectOk(
		await folder.write('notes/a.md', null, note('Walk', 'mine\n')),
	);
	expect(created.overridden).toEqual([]);
	expect(await onDisk('notes/a.md')).toBe(note('Walk', 'mine\n'));
	const logged = spyOn(console, 'info').mockImplementation(() => {});
	try {
		const again = expectOk(
			await folder.write('notes/a.md', null, note('Run', 'yours\n')),
		);
		expect(again.overridden).toEqual([{ kind: 'field', field: 'title' }]);
		expect(logged).toHaveBeenCalledTimes(1);
	} finally {
		logged.mockRestore();
	}
	expect(await onDisk('notes/a.md')).toBe(note('Run', 'mine\nyours\n'));
	await folder.close();
});

test('a write over a file another writer changed merges with them', async () => {
	const { root, folder, onDisk } = await directory();
	await mkdir(join(root, 'notes'));
	await writeFile(join(root, 'notes/a.md'), note('Walk', 'one\n'));
	// Another program appends after this writer read the file.
	await writeFile(join(root, 'notes/a.md'), note('Walk', 'one\ntheirs\n'));
	expectOk(
		await folder.write(
			'notes/a.md',
			note('Walk', 'one\n'),
			note('Walk', 'one\nmine\n', true),
		),
	);
	expect(await onDisk('notes/a.md')).toBe(
		note('Walk', 'one\nmine\ntheirs\n', true),
	);
	await folder.close();
});

test('a write that changes nothing puts nothing', async () => {
	const { boundary } = await rawBrowserFolder({ id: 'write.same' });
	expectOk(await boundary.put('a.txt', encoder.encode('same\n'), null));
	let puts = 0;
	const storage = {
		...boundary,
		put(...args: Parameters<typeof boundary.put>) {
			puts++;
			return boundary.put(...args);
		},
	};
	const written = expectOk(
		await writeFolderFile(storage, TEXT, 'a.txt', 'old\n', 'same\n'),
	);
	expect(puts).toBe(0);
	expect(decoder.decode(written.file?.bytes)).toBe('same\n');
});

test('a delete needs no from, and the deleter wins', async () => {
	const { root, folder } = await directory();
	await writeFile(join(root, 'a.txt'), 'theirs\n');
	expect(expectOk(await folder.write('a.txt', undefined, null))).toEqual({
		path: 'a.txt',
		file: null,
		overridden: [],
	});
	expect(expectErr(await folder.files.read('a.txt')).name).toBe('NotFound');
	// Deleting what is already gone is done.
	expectOk(await folder.write('a.txt', 'theirs\n', null));
	await folder.close();
});

test('a path no file can be at is InvalidPath, and a closed folder is Closed', async () => {
	const { root, folder } = await directory();
	await mkdir(join(root, 'notes'));
	expect(expectErr(await folder.write('.git/x', null, 'x')).name).toBe(
		'InvalidPath',
	);
	expect(expectErr(await folder.write('notes', null, 'x')).name).toBe(
		'InvalidPath',
	);
	await folder.close();
	expect(expectErr(await folder.write('a.txt', null, 'x')).name).toBe(
		'Closed',
	);
});
