/**
 * Sync's Merge Commit, as Objects
 *
 * `chooseBase` and `mergeHistories` over commits written straight into a
 * directory's repository: no files, index, or refs change.
 *
 * Key behaviors:
 * - Several merge bases, as hand-run merges leave, resolve to the newest by
 *   committer time, then the smallest object ID, so every host picks one
 * - The tree merges as the browser's Sync merges it: the remote's tree is
 *   current and this device's the change
 * - A path one side changed keeps that side's blob; one both changed merges
 *   by the shared content rules with this device winning, each lost unit an
 *   override naming the losing head
 * - A Markdown row merges by field at any depth, with no definition
 * - A delete never erases an edit it did not see, in either direction, and
 *   no rename is followed: a move against an edit keeps both paths
 * - A file against a directory takes this device's entry whole, and the
 *   remote's stays in its parent commit, named by an override
 * - JSON, `epicenter.json` included, merges by line like any text; local
 *   paths, tracked on any side, are in no merge
 * - `mergeMessage` writes one `Overrode:` trailer per lost unit
 */
import { afterAll, beforeAll, expect, test } from 'bun:test';
import * as isogit from 'isomorphic-git';
import { rawDirectoryFolder } from '../directory-history.test-support.js';
import { GIT_ENV } from '../git-http.test-support.js';
import { chooseBase, mergeHistories, mergeMessage } from './merge.js';
import {
	commitTree,
	type ObjectAccess,
	readBlob,
	readTreeFiles,
	writeFilesTree,
} from './objects.js';
import { readTree, writeTree } from './raw-objects.js';

const encoder = new TextEncoder();
const decoder = new TextDecoder();
const originalGlobal = process.env.GIT_CONFIG_GLOBAL;

beforeAll(() => {
	process.env.GIT_CONFIG_GLOBAL = GIT_ENV.GIT_CONFIG_GLOBAL;
});
afterAll(() => {
	if (originalGlobal === undefined) delete process.env.GIT_CONFIG_GLOBAL;
	else process.env.GIT_CONFIG_GLOBAL = originalGlobal;
});

async function objects() {
	const raw = await rawDirectoryFolder('merge-objects-');
	const backend = await raw.backend();
	return <T>(work: (access: ObjectAccess) => Promise<T>) =>
		backend.withObjects(work);
}

/** A commit of exactly `files` with `parents`, made at `time` (seconds). */
function commitOf(
	access: ObjectAccess,
	files: Record<string, string>,
	parents: string[],
	time: number,
) {
	return (async () => {
		const tree = await writeFilesTree(
			access,
			new Map(
				Object.entries(files).map(([path, text]) => [
					path,
					encoder.encode(text),
				]),
			),
		);
		const signature = {
			name: 'Test',
			email: 'test@example.test',
			timestamp: time,
			timezoneOffset: 0,
		};
		return isogit.writeCommit({
			...access,
			commit: {
				tree,
				parent: parents,
				author: signature,
				committer: signature,
				message: `At ${time}\n`,
			},
		});
	})();
}

async function treeText(access: ObjectAccess, tree: string) {
	const files = await readTreeFiles(access, tree);
	const out: Record<string, string> = {};
	for (const [path, entry] of files)
		out[path] = decoder.decode(await readBlob(access, entry.oid));
	return out;
}

test('several merge bases resolve to the newest, then the smallest object ID', async () => {
	const withObjects = await objects();
	await withObjects(async (access) => {
		const root = await commitOf(access, { a: '0\n' }, [], 100);
		const x = await commitOf(access, { a: 'x\n' }, [root], 200);
		const y = await commitOf(access, { a: 'y\n' }, [root], 300);
		// A criss-cross: each side merged the other by hand.
		const ours = await commitOf(access, { a: 'x\n' }, [x, y], 400);
		const theirs = await commitOf(access, { a: 'y\n' }, [y, x], 400);
		expect(
			(await isogit.findMergeBase({ ...access, oids: [ours, theirs] }))
				.slice()
				.sort(),
		).toEqual([x, y].sort());
		expect(await chooseBase(access, ours, theirs)).toBe(y);
		expect(await chooseBase(access, theirs, ours)).toBe(y);

		// Committed at the same second, the smaller object ID.
		const p = await commitOf(access, { a: 'p\n' }, [root], 500);
		const q = await commitOf(access, { a: 'q\n' }, [root], 500);
		const left = await commitOf(access, { a: 'p\n' }, [p, q], 600);
		const right = await commitOf(access, { a: 'q\n' }, [q, p], 600);
		expect(await chooseBase(access, left, right)).toBe(p < q ? p : q);

		const alone = await commitOf(access, { b: '1\n' }, [], 100);
		expect(await chooseBase(access, ours, alone)).toBeUndefined();
	});
});

test('one-sided changes keep their blob, and competing ones go to this device', async () => {
	const withObjects = await objects();
	await withObjects(async (access) => {
		const base = await commitOf(
			access,
			{
				'notes.md': 'one\ntwo\nthree\n',
				'only-ours': 'b\n',
				'only-theirs': 'b\n',
			},
			[],
			100,
		);
		const ours = await commitOf(
			access,
			{
				'notes.md': 'ONE\ntwo\nmine\n',
				'only-ours': 'o\n',
				'only-theirs': 'b\n',
			},
			[base],
			200,
		);
		const theirs = await commitOf(
			access,
			{
				'notes.md': 'one\ntwo\ntheirs\n',
				'only-ours': 'b\n',
				'only-theirs': 't\n',
			},
			[base],
			200,
		);
		const merged = await mergeHistories(access, {
			base,
			ours,
			theirs,
			isLocal: () => false,
		});
		expect(await treeText(access, merged.tree)).toEqual({
			'notes.md': 'ONE\ntwo\nmine\n',
			'only-ours': 'o\n',
			'only-theirs': 't\n',
		});
		expect(merged.overrides).toEqual([
			{
				path: 'notes.md',
				unit: { kind: 'lines', part: 'text', line: 3, count: 1 },
				losing: theirs,
			},
		]);
		expect(mergeMessage('Merge', merged.overrides)).toBe(
			`Merge\n\nOverrode: ${theirs} lines=text:3+1 "notes.md"`,
		);
		expect(mergeMessage('Merge', [])).toBe('Merge');
	});
});

test('a move against an edit keeps both paths: the edit is not erased by the delete it never saw', async () => {
	const withObjects = await objects();
	await withObjects(async (access) => {
		const row = '---\ntitle: Walk\ndone: false\n---\n';
		const done = row.replace('done: false', 'done: true');
		const base = await commitOf(access, { 'todos/walk.md': row }, [], 100);
		const ours = await commitOf(
			access,
			{ 'todos/stroll.md': row },
			[base],
			200,
		);
		const theirs = await commitOf(
			access,
			{ 'todos/walk.md': done },
			[base],
			200,
		);
		const merged = await mergeHistories(access, {
			base,
			ours,
			theirs,
			isLocal: () => false,
		});
		expect(await treeText(access, merged.tree)).toEqual({
			'todos/stroll.md': row,
			'todos/walk.md': done,
		});
		// The remote's edit stands whole, so the delete is what lost.
		expect(merged.overrides).toEqual([
			{ path: 'todos/walk.md', unit: { kind: 'file' }, losing: ours },
		]);
		expect(mergeMessage('Merge', merged.overrides)).toBe(
			`Merge\n\nOverrode: ${ours} file "todos/walk.md"`,
		);
	});
});

test("this device's edit stands over the remote's delete of the file", async () => {
	const withObjects = await objects();
	await withObjects(async (access) => {
		const base = await commitOf(
			access,
			{ 'a.txt': 'a\n', 'b.txt': 'b\n' },
			[],
			100,
		);
		const ours = await commitOf(
			access,
			{ 'a.txt': 'a\nmine\n', 'b.txt': 'b\n' },
			[base],
			200,
		);
		const theirs = await commitOf(access, { 'b.txt': 'b\n' }, [base], 200);
		const merged = await mergeHistories(access, {
			base,
			ours,
			theirs,
			isLocal: () => false,
		});
		expect(await treeText(access, merged.tree)).toEqual({
			'a.txt': 'a\nmine\n',
			'b.txt': 'b\n',
		});
		expect(merged.overrides).toEqual([
			{ path: 'a.txt', unit: { kind: 'file' }, losing: theirs },
		]);
	});
});

test("a file against a directory takes this device's entry whole, and the remote's stays in its parent", async () => {
	const withObjects = await objects();
	await withObjects(async (access) => {
		const base = await commitOf(access, { keep: 'k\n' }, [], 100);
		const ours = await commitOf(
			access,
			{ keep: 'k\n', a: 'mine\n', 'b/c': 'dir\n' },
			[base],
			200,
		);
		const theirs = await commitOf(
			access,
			{ keep: 'k\n', 'a/b': 'dir\n', b: 'theirs\n' },
			[base],
			200,
		);
		const merged = await mergeHistories(access, {
			base,
			ours,
			theirs,
			isLocal: () => false,
		});
		expect(await treeText(access, merged.tree)).toEqual({
			keep: 'k\n',
			a: 'mine\n',
			'b/c': 'dir\n',
		});
		expect(merged.overrides).toEqual([
			{ path: 'a', unit: { kind: 'file' }, losing: theirs },
			{ path: 'b', unit: { kind: 'file' }, losing: theirs },
		]);
		// Nothing is lost: the merge commit's remote parent still holds both.
		expect(await treeText(access, await commitTree(access, theirs))).toEqual({
			keep: 'k\n',
			'a/b': 'dir\n',
			b: 'theirs\n',
		});
	});
});

test('a row two levels deep merges by field, with no definition', async () => {
	const withObjects = await objects();
	await withObjects(async (access) => {
		const path = 'notes/2026/walk.md';
		const row = (title: string, done: string) =>
			`---\ntitle: ${title}\ndone: ${done}\n---\nLeft at dawn.\n`;
		const base = await commitOf(
			access,
			{ [path]: row('Walk', 'false') },
			[],
			100,
		);
		const ours = await commitOf(
			access,
			{ [path]: row('Evening walk', 'false') },
			[base],
			200,
		);
		const theirs = await commitOf(
			access,
			{ [path]: row('Walk', 'true') },
			[base],
			200,
		);
		const merged = await mergeHistories(access, {
			base,
			ours,
			theirs,
			isLocal: () => false,
		});
		expect(await treeText(access, merged.tree)).toEqual({
			[path]: row('Evening walk', 'true'),
		});
		expect(merged.overrides).toEqual([]);
	});
});

test('epicenter.json merges by line, and local paths tracked on any side are in no merge', async () => {
	const withObjects = await objects();
	await withObjects(async (access) => {
		const declaration = (theme: string, size: string) =>
			`{\n\t"meta": {\n\t\t"theme": ${theme},\n\t\t"size": ${size}\n\t}\n}\n`;
		const base = await commitOf(
			access,
			{ 'epicenter.json': declaration('1', '1'), 'cache.db': 'base\n' },
			[],
			100,
		);
		const ours = await commitOf(
			access,
			{
				'epicenter.json': declaration('2', '1'),
				'cache.db': 'ours\n',
				'audio/mine.wav': 'RIFF mine',
			},
			[base],
			200,
		);
		const theirs = await commitOf(
			access,
			{
				'epicenter.json': declaration('1', '2'),
				'cache.db': 'theirs\n',
				'audio/theirs.wav': 'RIFF theirs',
			},
			[base],
			200,
		);
		const merged = await mergeHistories(access, {
			base,
			ours,
			theirs,
			isLocal: (path) => path.endsWith('.db') || path.startsWith('audio/'),
		});
		// Each side changed its own line, so both stand, in its spelling.
		expect(await treeText(access, merged.tree)).toEqual({
			'epicenter.json': declaration('2', '2'),
		});
		expect(merged.overrides).toEqual([]);
	});
});

test('filtering tracked local files keeps unrelated raw Git names unchanged', async () => {
	const withObjects = await objects();
	await withObjects(async (access) => {
		const initial = await commitOf(
			access,
			{ 'audio/private.wav': 'private', 'notes/a.md': '---\ntitle: A\n---\n' },
			[],
			100,
		);
		const original = await isogit.readCommit({ ...access, oid: initial });
		const root = await isogit.readObject({
			...access,
			oid: original.commit.tree,
			format: 'content',
		});
		if (!(root.object instanceof Uint8Array))
			throw new Error('Expected tree bytes');
		const rawBlob = await isogit.writeBlob({
			...access,
			blob: encoder.encode('raw'),
		});
		const rawName = Uint8Array.of(0xfe);
		const audioTree = await isogit.writeObject({
			...access,
			type: 'tree',
			object: writeTree([
				{ name: rawName, mode: '100644', oid: rawBlob },
				{
					name: Uint8Array.of(0xfd),
					mode: '40000',
					oid: await isogit.writeObject({
						...access,
						type: 'tree',
						object: writeTree([
							{ name: encoder.encode('child'), mode: '100644', oid: rawBlob },
						]),
						format: 'content',
					}),
				},
			]),
			format: 'content',
		});
		const tree = await isogit.writeObject({
			...access,
			type: 'tree',
			object: writeTree([
				...readTree(root.object).map((entry) =>
					decoder.decode(entry.name) === 'audio'
						? { ...entry, oid: audioTree }
						: entry,
				),
				{ name: rawName, mode: '100644', oid: rawBlob },
			]),
			format: 'content',
		});
		const commit = await isogit.writeCommit({
			...access,
			commit: { ...original.commit, tree },
		});
		const merged = await mergeHistories(access, {
			base: commit,
			ours: commit,
			theirs: commit,
			isLocal: (path) => path.startsWith('audio/'),
		});
		const result = await isogit.readObject({
			...access,
			oid: merged.tree,
			format: 'content',
		});
		if (!(result.object instanceof Uint8Array))
			throw new Error('Expected tree bytes');
		const entries = readTree(result.object);
		expect(
			entries.some((entry) => entry.name[0] === 0xfe && entry.oid === rawBlob),
		).toBe(true);
		expect(
			entries.some((entry) => decoder.decode(entry.name) === 'audio'),
		).toBe(false);
	});
});

test('raw-name conflicts name the parent whose bytes lost', async () => {
	const withObjects = await objects();
	await withObjects(async (access) => {
		const rawName = Uint8Array.of(0xfe);
		const rawTextName = Uint8Array.of(0xfd);
		const commit = async (
			binary: Uint8Array,
			text: string,
			parent: string[],
			time: number,
		) => {
			const binaryOid = await isogit.writeBlob({ ...access, blob: binary });
			const textOid = await isogit.writeBlob({
				...access,
				blob: encoder.encode(text),
			});
			const tree = await isogit.writeObject({
				...access,
				type: 'tree',
				object: writeTree([
					{ name: rawName, mode: '100644', oid: binaryOid },
					{ name: rawTextName, mode: '100644', oid: textOid },
				]),
				format: 'content',
			});
			const signature = {
				name: 'Test',
				email: 'test@example.test',
				timestamp: time,
				timezoneOffset: 0,
			};
			return isogit.writeCommit({
				...access,
				commit: {
					tree,
					parent,
					author: signature,
					committer: signature,
					message: `At ${time}\n`,
				},
			});
		};
		const base = await commit(Uint8Array.of(0, 1, 2), 'base\n', [], 100);
		const theirs = await commit(
			Uint8Array.of(0, 1, 3),
			'remote\n',
			[base],
			200,
		);
		const ours = await commit(Uint8Array.of(0, 1, 4), 'local\n', [base], 300);
		const merged = await mergeHistories(access, {
			base,
			ours,
			theirs,
			isLocal: () => false,
		});
		expect(merged.overrides).toEqual([
			{
				path: 'raw:fd',
				unit: { kind: 'lines', part: 'text', line: 1, count: 1 },
				losing: theirs,
			},
			{ path: 'raw:fe', unit: { kind: 'file' }, losing: theirs },
		]);
	});
});

test("JSON lines both sides changed are this device's, and lines only one side added stand", async () => {
	const withObjects = await objects();
	await withObjects(async (access) => {
		const declaration = (title: string, local: string[]) =>
			`${JSON.stringify({ title, local }, null, 2)}\n`;
		const base = await commitOf(
			access,
			{ 'epicenter.json': declaration('Base', ['audio/']) },
			[],
			100,
		);
		const ours = await commitOf(
			access,
			{ 'epicenter.json': declaration('Mine', ['audio/', 'cache/']) },
			[base],
			200,
		);
		const theirs = await commitOf(
			access,
			{ 'epicenter.json': declaration('Theirs', ['video/', 'audio/']) },
			[base],
			200,
		);
		const merged = await mergeHistories(access, {
			base,
			ours,
			theirs,
			isLocal: () => false,
		});
		expect(await treeText(access, merged.tree)).toEqual({
			'epicenter.json': declaration('Mine', ['video/', 'audio/', 'cache/']),
		});
		expect(merged.overrides).toEqual([
			{
				path: 'epicenter.json',
				unit: { kind: 'lines', part: 'text', line: 2, count: 1 },
				losing: theirs,
			},
		]);
		expect(mergeMessage('Merge', merged.overrides)).toBe(
			`Merge\n\nOverrode: ${theirs} lines=text:2+1 "epicenter.json"`,
		);
	});
});
