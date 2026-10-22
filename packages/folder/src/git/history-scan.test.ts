/**
 * History source capture and final inspection.
 * Ignore rules select payloads before reads, while tracked content and fresh
 * final observations remain authoritative. Rule failures cannot imply clean.
 */
import { expect, test } from 'bun:test';
import { stat, symlink, utimes, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { createLogger, memorySink } from 'wellcrafted/logger';
import { expectErr, expectOk } from 'wellcrafted/testing';
import { rawDirectoryFolder } from '../directory-history.test-support.js';
import { nodeDirectoryPrimitives } from '../directory-node.js';
import { FileError } from '../errors.js';
import { git } from '../git-http.test-support.js';
import { holdingHistoryLock } from '../native/directory.js';
import { overwrite } from '../put.test-support.js';
import { executeHistoryRequest } from './history.js';
import { runNativeHistory } from './native-history.js';
import { createGitRunner } from './native-host.js';

const author = { name: 'Scan', email: 'scan@example.test' };

test.each(['status', 'saveVersion'] as const)(
	'%s reads tracked and re-included audio, but never ignored payloads',
	async (op) => {
		const raw = await rawDirectoryFolder('history-scan-');
		const host = {
			run: createGitRunner(raw.root),
			files: nodeDirectoryPrimitives,
		};
		await overwrite(raw.boundary, 'tracked.wav', 'old');
		await runNativeHistory({
			rootPath: raw.root,
			host,
			boundary: raw.boundary,
			author,
			request: { op: 'saveVersion' },
		});
		for (const [path, text] of Object.entries({
			'.gitignore': '*.wav\ncache/\n',
			'notes/.gitignore': '!keep.wav\n',
			'tracked.wav': 'new',
			'notes/keep.wav': 'included',
			'notes/drop.wav': 'ignored',
			'cache/payload.dat': 'ignored',
			'machine.dat': 'ignored by info/exclude',
			'note.md': 'included',
		}))
			await overwrite(raw.boundary, path, text);
		await symlink(join(raw.root, 'note.md'), join(raw.root, 'linked.wav'));
		await writeFile(join(raw.root, '.git/info/exclude'), 'machine.dat\n');
		const reads: string[][] = [];
		const reply = await runNativeHistory({
			rootPath: raw.root,
			host,
			author,
			request: { op },
			boundary: {
				...raw.boundary,
				async list() {
					reads.push([]);
					return raw.boundary.list();
				},
				async read(path) {
					const scan = reads.at(-1);
					if (scan === undefined) throw new Error('Read before listing');
					scan.push(path);
					return raw.boundary.read(path);
				},
			},
		});
		const included = [
			'.gitignore',
			'note.md',
			'notes/.gitignore',
			'notes/keep.wav',
			'tracked.wav',
		].sort();
		expect(reply.state.files).toBeDefined();
		expect(reads).toHaveLength(op === 'status' ? 1 : 2);
		for (const scan of reads) expect(scan.sort()).toEqual(included);
		if (op === 'saveVersion') {
			expect(reply.result).toMatchObject({ status: 'committed' });
			expect(reply.state.files?.changes).toEqual([]);
			expect((await git(raw.root, 'ls-files')).split('\n').sort()).toEqual(
				included,
			);
		} else
			expect(
				reply.state.files?.changes.map((change) => change.path).sort(),
			).toEqual(included);
	},
);

test('an unborn status filters audio using captured rules without creating Git state', async () => {
	const raw = await rawDirectoryFolder('history-scan-unborn-');
	await overwrite(raw.boundary, '.gitignore', '*.wav\n');
	await overwrite(raw.boundary, 'audio.wav', 'ignored');
	const reads: string[] = [];
	const reply = await runNativeHistory({
		rootPath: raw.root,
		host: { run: createGitRunner(raw.root), files: nodeDirectoryPrimitives },
		author,
		request: { op: 'status' },
		boundary: {
			...raw.boundary,
			async read(path) {
				reads.push(path);
				return raw.boundary.read(path);
			},
		},
	});
	expect(expectOk(reply.result).changes).toEqual([
		{ path: '.gitignore', kind: 'add' },
	]);
	expect(reads).toEqual(['.gitignore']);
	expect(
		await nodeDirectoryPrimitives.lstat(join(raw.root, '.git')),
	).toBeUndefined();
});

test('selection and checkpoint reuse the same ignore bytes despite a concurrent rule edit', async () => {
	const raw = await rawDirectoryFolder('history-scan-rules-');
	await overwrite(raw.boundary, '.gitignore', '*.wav\n');
	await overwrite(raw.boundary, 'audio.wav', 'ignored at capture');
	let lists = 0;
	const reads: string[][] = [];
	const reply = await runNativeHistory({
		rootPath: raw.root,
		host: { run: createGitRunner(raw.root), files: nodeDirectoryPrimitives },
		author,
		request: { op: 'saveVersion' },
		boundary: {
			...raw.boundary,
			async list() {
				lists++;
				reads.push([]);
				return raw.boundary.list();
			},
			async read(path) {
				const scan = reads.at(-1);
				if (scan === undefined) throw new Error('Read before listing');
				scan.push(path);
				const result = await raw.boundary.read(path);
				if (lists === 1 && path === '.gitignore')
					await writeFile(join(raw.root, '.gitignore'), '');
				return result;
			},
		},
	});
	expect(reply.result.status).toBe('committed');
	expect(await git(raw.root, 'show', 'HEAD:.gitignore')).toBe('*.wav');
	expect(await git(raw.root, 'ls-files')).toBe('.gitignore');
	expect(reads[0]).toEqual(['.gitignore']);
	expect(reads[1]?.sort()).toEqual(['.gitignore', 'audio.wav']);
	expect(reply.state.files?.changes).toEqual([
		{ path: '.gitignore', kind: 'modify' },
		{ path: 'audio.wav', kind: 'add' },
	]);
});

test('a final inspection rereads same-size content even when its timestamp is unchanged', async () => {
	const raw = await rawDirectoryFolder('history-scan-timestamp-');
	const backend = await raw.backend();
	await overwrite(raw.boundary, 'a.md', 'old');
	const saved = await stat(join(raw.root, 'a.md'));
	const reply = await holdingHistoryLock(raw.root, () =>
		executeHistoryRequest(
			{
				boundary: raw.boundary,
				getAuthor: () => author,
				backend: {
					...backend,
					async reconcileIndex(head) {
						await backend.reconcileIndex(head);
						await writeFile(join(raw.root, 'a.md'), 'new');
						await utimes(join(raw.root, 'a.md'), saved.atime, saved.mtime);
					},
				},
			},
			{ op: 'saveVersion' },
		),
	);
	expect(reply.result.status).toBe('committed');
	expect(reply.state.files?.changes).toEqual([
		{ path: 'a.md', kind: 'modify' },
	]);
});

test('an unreadable rule fails inspection without revoking a completed checkpoint', async () => {
	const raw = await rawDirectoryFolder('history-scan-rule-failure-');
	const backend = await raw.backend();
	await overwrite(raw.boundary, '.gitignore', '*.wav\n');
	await overwrite(raw.boundary, 'audio.wav', 'ignored');
	let fail = false;
	const { sink } = memorySink();
	const boundary = {
		...raw.boundary,
		read: (path: string) =>
			fail && path === '.gitignore'
				? Promise.resolve(
						FileError.Io({
							path,
							operation: 'read',
							cause: new Error('unreadable rule'),
						}),
					)
				: raw.boundary.read(path),
	};
	const reply = await holdingHistoryLock(raw.root, () =>
		executeHistoryRequest(
			{
				boundary,
				getAuthor: () => author,
				log: createLogger('test/scan', sink),
				backend: {
					...backend,
					async reconcileIndex(head) {
						await backend.reconcileIndex(head);
						fail = true;
					},
				},
			},
			{ op: 'saveVersion' },
		),
	);
	expect(reply.result.status).toBe('committed');
	expect(reply.state.files).toBeUndefined();
	const status = await executeHistoryRequest(
		{ boundary, backend, getAuthor: () => author },
		{ op: 'status' },
	);
	expect(expectErr(status.result).message).toContain('.gitignore');
});

test('tracked bypass and comparison use the same head when an external commit lands during inspection', async () => {
	const raw = await rawDirectoryFolder('history-scan-head-');
	const host = {
		run: createGitRunner(raw.root),
		files: nodeDirectoryPrimitives,
	};
	await overwrite(raw.boundary, '.gitignore', '*.wav\n');
	await overwrite(raw.boundary, 'audio.wav', 'ignored until force-added');
	await runNativeHistory({
		rootPath: raw.root,
		host,
		boundary: raw.boundary,
		author,
		request: { op: 'saveVersion' },
	});
	const before = await git(raw.root, 'rev-parse', 'main');
	const reads: string[] = [];
	const reply = await runNativeHistory({
		rootPath: raw.root,
		host,
		author,
		request: { op: 'status' },
		boundary: {
			...raw.boundary,
			async list() {
				await git(raw.root, 'add', '--force', '--', 'audio.wav');
				await git(raw.root, 'commit', '--quiet', '-m', 'Force-track audio');
				return raw.boundary.list();
			},
			async read(path) {
				reads.push(path);
				return raw.boundary.read(path);
			},
		},
	});
	const after = await git(raw.root, 'rev-parse', 'main');
	expect(after).not.toBe(before);
	expect(expectOk(reply.result)).toEqual({ head: before, changes: [] });
	expect(reads).toEqual(['.gitignore']);
	const next = await runNativeHistory({
		rootPath: raw.root,
		host,
		boundary: raw.boundary,
		author,
		request: { op: 'status' },
	});
	expect(expectOk(next.result)).toEqual({ head: after, changes: [] });
});

test('failed final ignore evaluation preserves the checkpoint receipt and omits files', async () => {
	const raw = await rawDirectoryFolder('history-scan-ignore-failure-');
	const backend = await raw.backend();
	await overwrite(raw.boundary, '.gitignore', '*.wav\n');
	await overwrite(raw.boundary, 'audio.wav', 'ignored');
	let evaluations = 0;
	const { sink } = memorySink();
	const reply = await holdingHistoryLock(raw.root, () =>
		executeHistoryRequest(
			{
				boundary: raw.boundary,
				getAuthor: () => author,
				log: createLogger('test/scan', sink),
				backend: {
					...backend,
					ignoredPaths(candidates, rules) {
						if (++evaluations === 2)
							throw new Error('final ignore evaluation failed');
						return backend.ignoredPaths(candidates, rules);
					},
				},
			},
			{ op: 'saveVersion' },
		),
	);
	expect(evaluations).toBe(2);
	expect(reply.result.status).toBe('committed');
	expect(reply.state.lastCommit?.status).toBe('committed');
	expect(reply.state.files).toBeUndefined();
});
