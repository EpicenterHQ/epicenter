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
 * - A delete and an edit are the whole file: the delete beats an edit it
 *   never saw, and only a write from no file creates one
 * - A write from no file onto a file already there is `Occupied` and
 *   changes nothing, unless the file holds the same bytes: a retried create
 *   is done
 * - A version that does not read as a row merges as text
 * - `put` lands only while the path holds `ifMatch`, and is `'stale'`
 *   otherwise, changing nothing
 * - A write that loses a race reads and merges again, and gives up as
 *   `KeptChanging` after `WRITE_ATTEMPTS`
 * - A write that changes nothing puts nothing
 * - A delete needs no base; a closed folder is `Closed`; a path no file
 *   can be at is `InvalidPath`
 * - `folder.move` puts a file's bytes at a vacant path as they are and
 *   removes them from their own; no file at the source is `InvalidPath`,
 *   and one at the destination `Occupied` (its races are in `table.test.ts`,
 *   through `rename`)
 */
import { afterAll, beforeAll, expect, test } from 'bun:test';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { expectErr, expectOk } from 'wellcrafted/testing';
import { rawBrowserFolder } from './browser-storage.test-support.js';
import { openFolder } from './bun.js';
import { defineFolder, defineTable, field, hashBytes } from './contract.js';
import { prepareFolderDefinition } from './definition.js';
import { fileKindOf, merge } from './merge-file.js';
import { WRITE_ATTEMPTS, writeFile as writeFolderFile } from './write.js';

const definition = defineFolder({
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
		overridden: [{ kind: 'lines', part: 'body', line: 2, count: 1 }],
	});
});

test('two appends to one body both survive, and two identical fills are one', async () => {
	expect(
		await merge(ROW, {
			base: note('Walk', 'Notes'),
			ours: note('Walk', 'Notes\nmine'),
			theirs: note('Walk', 'Notes\nyours'),
		}),
	).toEqual({ content: note('Walk', 'Notes\nyours\nmine'), overridden: [] });
	expect(
		await merge(ROW, {
			base: note('Walk'),
			ours: note('Walk', 'The answer.\n'),
			theirs: note('Walk', 'The answer.\n'),
		}),
	).toEqual({ content: note('Walk', 'The answer.\n'), overridden: [] });
});

test('a merged row is written canonically, and a row the writer left alone keeps the other spelling', async () => {
	const handWritten = row(['# a comment', "title: 'Walk'", 'done: false']);
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

test('a delete and an edit are the whole file, and the delete beats the edit it never saw', async () => {
	expect(
		await merge(ROW, {
			base: note('Walk'),
			ours: null,
			theirs: note('Run'),
		}),
	).toEqual({
		content: null,
		overridden: [{ kind: 'file', lost: 'theirs' }],
	});
	expect(
		await merge(ROW, {
			base: note('Walk'),
			ours: note('Run'),
			theirs: null,
		}),
	).toEqual({
		content: null,
		overridden: [{ kind: 'file', lost: 'ours' }],
	});
	// Only a side with no base brings a file into existence.
	expect(
		await merge(ROW, { base: null, ours: note('Run'), theirs: null }),
	).toEqual({ content: note('Run'), overridden: [] });
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
	).toEqual({
		content: bytes(2),
		overridden: [{ kind: 'file', lost: 'theirs' }],
	});
});

test('a row merged as text never joins two lines added at one place in its frontmatter', async () => {
	const base = '---\ntitle: Walk\n---\nbody\n';
	const merged = await merge(ROW, {
		base,
		// Neither reads as a row of this table, so the rows merge as text.
		ours: '---\ntitle: Walk\ncolor: red\n---\nbody\nmine\n',
		theirs: '---\ntitle: Walk\ncolor: blue\n---\nbody\nyours\n',
	});
	// The frontmatter lines compete, and the writer's stands alone; the
	// body's insertions both stay.
	expect(merged.content).toBe(
		'---\ntitle: Walk\ncolor: red\n---\nbody\nyours\nmine\n',
	);
	expect(merged.overridden).toEqual([
		{ kind: 'lines', part: 'text', line: 3, count: 1 },
	]);
});

test('the merge driver asks for either side to win, with the same lines kept beside it', async () => {
	const versions = {
		base: 'a\nb\nc\n',
		ours: 'a\nB (ours)\nc\nadded\n',
		theirs: 'a\nB (theirs)\nc\n',
	};
	expect((await merge(TEXT, versions)).content).toBe('a\nB (ours)\nc\nadded\n');
	expect((await merge(TEXT, versions, { winner: 'theirs' })).content).toBe(
		'a\nB (theirs)\nc\nadded\n',
	);
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
	expectOk(
		await boundary.put('notes/a.md', encoder.encode(note('Walk')), null),
	);
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
				await boundary.put('n.txt', encoder.encode(`${++count}\n`), now.sha256),
			);
			return boundary.put(...args);
		},
	};
	const error = expectErr(
		await writeFolderFile(storage, TEXT, 'n.txt', '0\n', '0\nmine\n'),
	);
	expect(error).toMatchObject({
		name: 'KeptChanging',
		attempts: WRITE_ATTEMPTS,
	});
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
			app: basename(root),
			root,
			definition,
			git: { author: { name: 'Folders', email: 'folders@localhost' } },
		}),
	);
	const onDisk = (path: string) => readFile(join(root, path), 'utf8');
	return { root, folder, onDisk };
}

test('a create makes the file and its directory; a second create is refused, and the same one sent again is done', async () => {
	const { folder, onDisk } = await directory();
	const created = expectOk(
		await folder.write('notes/a.md', null, note('Walk', 'mine\n')),
	);
	expect(created.overridden).toEqual([]);
	expect(await onDisk('notes/a.md')).toBe(note('Walk', 'mine\n'));
	expect(
		expectErr(await folder.write('notes/a.md', null, note('Run', 'yours\n'))),
	).toMatchObject({ name: 'Occupied', path: 'notes/a.md' });
	expect(await onDisk('notes/a.md')).toBe(note('Walk', 'mine\n'));
	// A retried create finds its own bytes there.
	const again = expectOk(
		await folder.write('notes/a.md', null, note('Walk', 'mine\n')),
	);
	expect(again).toEqual(created);
	expect(await onDisk('notes/a.md')).toBe(note('Walk', 'mine\n'));
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
		note('Walk', 'one\ntheirs\nmine\n', true),
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

test('a delete needs no base, and the deleter wins', async () => {
	const { root, folder } = await directory();
	await writeFile(join(root, 'a.txt'), 'theirs\n');
	expect(expectOk(await folder.write('a.txt', null, null))).toEqual({
		path: 'a.txt',
		file: null,
		overridden: [],
	});
	// A delete that names its base reports a change it removed.
	await writeFile(join(root, 'b.txt'), 'theirs\n');
	expect(
		expectOk(await folder.write('b.txt', 'mine\n', null)).overridden,
	).toEqual([{ kind: 'file', lost: 'theirs' }]);
	expect(expectErr(await folder.files.read('a.txt')).name).toBe('NotFound');
	// Deleting what is already gone is done.
	expectOk(await folder.write('a.txt', 'theirs\n', null));
	await folder.close();
});

test('an edit of a file deleted since its version writes nothing and answers no file', async () => {
	const { folder } = await directory();
	const written = expectOk(
		await folder.write('a.txt', 'mine\n', 'mine\nmore\n'),
	);
	expect(written).toEqual({ path: 'a.txt', file: null, overridden: [] });
	expect(expectErr(await folder.files.read('a.txt')).name).toBe('NotFound');
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
	expect(expectErr(await folder.write('a.txt', null, 'x')).name).toBe('Closed');
});

test('a move puts the file at a vacant path as it is and removes it from its own', async () => {
	const { root, folder, onDisk } = await directory();
	await mkdir(join(root, 'audio'));
	const take = new Uint8Array([0, 1, 2, 255]);
	await writeFile(join(root, 'audio/take.wav'), take);
	const moved = expectOk(
		await folder.move('audio/take.wav', 'archive/take.wav'),
	);
	expect(moved).toEqual({
		path: 'archive/take.wav',
		file: { bytes: take, sha256: await hashBytes(take) },
		overridden: [],
	});
	expect(expectErr(await folder.files.read('audio/take.wav')).name).toBe(
		'NotFound',
	);
	// A row moves as its bytes, with no canonical rewrite.
	await mkdir(join(root, 'notes'));
	await writeFile(join(root, 'notes/a.md'), '---\ntitle:   Spaced\n---\n');
	expectOk(await folder.move('notes/a.md', 'notes/b.md'));
	expect(await onDisk('notes/b.md')).toBe('---\ntitle:   Spaced\n---\n');
	await folder.close();
});

test('a move from no file is InvalidPath, onto a file Occupied, and changes nothing', async () => {
	const { root, folder, onDisk } = await directory();
	await writeFile(join(root, 'a.txt'), 'a\n');
	await writeFile(join(root, 'b.txt'), 'b\n');
	expect(expectErr(await folder.move('gone.txt', 'c.txt'))).toMatchObject({
		name: 'InvalidPath',
		path: 'gone.txt',
	});
	expect(expectErr(await folder.move('a.txt', 'b.txt'))).toMatchObject({
		name: 'Occupied',
		path: 'b.txt',
	});
	expect(await onDisk('a.txt')).toBe('a\n');
	expect(await onDisk('b.txt')).toBe('b\n');
	// Onto its own path, a move answers the file as it is.
	expect(expectOk(await folder.move('a.txt', 'a.txt')).file?.bytes).toEqual(
		encoder.encode('a\n'),
	);
	await folder.close();
	expect(expectErr(await folder.move('a.txt', 'c.txt')).name).toBe('Closed');
});
