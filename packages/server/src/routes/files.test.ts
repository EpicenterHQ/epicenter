/**
 * The write translator against the disk store and a real bare repository:
 * one commit per request, the note merge, conflict copies, an edit beating
 * a delete, and capture receipts (decision 50).
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import { rm } from 'node:fs/promises';
import { join } from 'node:path';
import { REPOSITORY_ATTRIBUTES } from '@epicenter/definition/contract';
import { conflictSibling } from '@epicenter/definition/merge';
import { type GitObjects, MAIN, readCommit, ZERO_OID } from '../git/objects.js';
import { createDiskGitHost, repositoryPath } from '../git-disk-store.js';
import { createDiskLfsStore } from '../lfs/disk-lfs-store.js';
import type { LfsStore } from '../lfs/lfs-store.js';
import { newRepositoryId } from '../repositories.js';
import {
	createGitSandbox,
	type GitSandbox,
} from '../test-helpers/sandbox-git.js';
import {
	applyWrite,
	captureRef,
	listRepositoryFiles,
	type Receipt,
	readRepositoryFile,
	readWriteRequest,
	type WriteRequest,
} from './files.js';

let box: GitSandbox;
let host: ReturnType<typeof createDiskGitHost>;
let lfs: LfsStore;
const author = { name: 'Web', email: 'web@example.test' };

beforeAll(async () => {
	box = await createGitSandbox();
	host = createDiskGitHost({ root: join(box.root, 'store') });
	lfs = createDiskLfsStore({ root: join(box.root, 'lfs') });
});
afterAll(async () => {
	await rm(box.root, { recursive: true, force: true });
});

type Repo = {
	id: string;
	objects: GitObjects;
	gitDir: string;
	write(
		request: WriteRequest,
		hold?: () => Promise<void>,
	): Promise<{ status: number; body: Receipt & { error?: string } }>;
	main(): Promise<string>;
	show(path: string): Promise<string>;
};

async function repository(): Promise<Repo> {
	const id = newRepositoryId();
	await host.create(id);
	const objects = host.objects?.(id) as GitObjects;
	const gitDir = repositoryPath(join(box.root, 'store'), id);
	return {
		id,
		objects,
		gitDir,
		async write(request, hold) {
			const checked = readWriteRequest(request);
			if ('status' in checked)
				return { status: checked.status, body: checked as never };
			const response = await applyWrite({
				objects: host.objects?.(id) as GitObjects,
				lfs,
				repositoryId: id,
				request: checked,
				author,
				hold,
			});
			return { status: response.status, body: await response.json() };
		},
		async main() {
			return (await objects.refs()).get(MAIN) ?? ZERO_OID;
		},
		show(path) {
			return box.ok(gitDir, ['show', `main:${path}`]);
		},
	};
}

async function upload(repo: Repo, bytes: Uint8Array) {
	const oid = createHash('sha256').update(bytes).digest('hex');
	await lfs.put(repo.id, oid, new Blob([bytes as BlobPart]).stream());
	return { oid, size: bytes.length };
}

const note = (fields: Record<string, string>, body: string) =>
	`---\n${Object.entries(fields)
		.map(([k, v]) => `${k}: ${v}`)
		.join('\n')}\n---\n${body}`;

describe('POST writes', () => {
	test('a capture (note plus audio) is one commit, and its receipt names both blobs', async () => {
		const repo = await repository();
		const audio = new TextEncoder().encode('RIFF fake audio');
		const files = [
			{ path: 'recordings/a.md', text: note({ title: 'Standup' }, 'Hello\n') },
			{ path: 'recordings/a.webm', lfs: { oid: 'x', size: 0 } },
		];
		const object = {
			oid: createHash('sha256').update(audio).digest('hex'),
			size: audio.length,
		};
		files[1] = { path: 'recordings/a.webm', lfs: object };
		const before = await repo.write({ captureId: 'cap-a', files });
		expect(before.status).toBe(409);
		expect(before.body.error).toBe('lfs_not_uploaded');
		expect(await repo.main()).toBe(ZERO_OID);

		await upload(repo, audio);
		const landed = await repo.write({ captureId: 'cap-a', files });
		expect(landed.status).toBe(200);
		expect(landed.body.paths).toEqual(['recordings/a.md', 'recordings/a.webm']);
		expect(await repo.main()).toBe(landed.body.commit);
		expect(
			(await box.ok(repo.gitDir, ['rev-list', '--count', 'main'])).trim(),
		).toBe('1');
		for (const path of landed.body.paths)
			expect(landed.body.blobs[path]).toBe(
				(await box.ok(repo.gitDir, ['rev-parse', `main:${path}`])).trim(),
			);
		expect(await repo.show('recordings/a.webm')).toBe(
			`version https://git-lfs.github.com/spec/v1\noid sha256:${object.oid}\nsize ${object.size}\n`,
		);
		const message = await box.ok(repo.gitDir, ['log', '-1', '--format=%B']);
		expect(message).toContain('Epicenter-Capture: cap-a');

		// A replay returns the same receipt, and main does not move.
		const replay = await repo.write({ captureId: 'cap-a', files });
		expect(replay.body).toMatchObject({
			commit: landed.body.commit,
			paths: landed.body.paths,
			blobs: landed.body.blobs,
			replayed: true,
		});
		expect(await repo.main()).toBe(landed.body.commit);
		// The receipt is a ref beside main, which no client is shown.
		expect((await repo.objects.refs()).get(captureRef('cap-a'))).toBe(
			landed.body.commit,
		);
	});

	test("a repository's first commit holds the standard .gitattributes (decision 59)", async () => {
		const repo = await repository();
		const first = await repo.write({
			captureId: 'cap-first',
			files: [{ path: 'recordings/a.md', text: 'a\n' }],
		});
		expect(await repo.show('.gitattributes')).toBe(REPOSITORY_ATTRIBUTES);
		// The receipt names the request's files only.
		expect(first.body.paths).toEqual(['recordings/a.md']);
		// Later writes leave it alone.
		await repo.write({ files: [{ path: 'b.md', text: 'b\n' }] });
		expect(
			(
				await box.ok(repo.gitDir, [
					'log',
					'--format=%s',
					'--',
					'.gitattributes',
				])
			).trim(),
		).toBe('Capture cap-first');

		// A first write that brings its own keeps it.
		const own = await repository();
		await own.write({
			files: [{ path: '.gitattributes', text: '*.bin filter=lfs\n' }],
		});
		expect(await own.show('.gitattributes')).toBe('*.bin filter=lfs\n');
	});

	test('a hidden path takes text, being outside the contract (decision 58)', async () => {
		const repo = await repository();
		const written = await repo.write({
			files: [{ path: '.epicenter/settings.json', text: '{}\n' }],
		});
		expect(written.status).toBe(200);
	});

	test('refuses what a write may not hold', async () => {
		const repo = await repository();
		const refused = async (request: unknown) =>
			(await repo.write(request as WriteRequest)).status;
		expect(await refused({ files: [{ path: 'a.webm', text: 'raw' }] })).toBe(
			400,
		);
		expect(
			await refused({
				files: [{ path: 'a.md', lfs: { oid: 'a'.repeat(64), size: 1 } }],
			}),
		).toBe(400);
		expect(
			await refused({
				root: 'notes',
				files: [{ path: 'other/a.md', text: 'x' }],
			}),
		).toBe(400);
		expect(await refused({ files: [{ path: '../a.md', text: 'x' }] })).toBe(
			400,
		);
		expect(await refused({ files: [{ path: '.git/config', text: 'x' }] })).toBe(
			400,
		);
		expect(await refused({ files: [{ path: 'a.md', delete: true }] })).toBe(
			400,
		);
		expect(
			await refused({
				files: [
					{ path: 'a.md', text: 'x' },
					{ path: 'a.md', text: 'y' },
				],
			}),
		).toBe(400);
		expect(
			await refused({
				captureId: 'no spaces',
				files: [{ path: 'a.md', text: 'x' }],
			}),
		).toBe(400);
		expect(await repo.main()).toBe(ZERO_OID);
	});

	test('two writes from one base both land: fields by key, body by line, history linear', async () => {
		const repo = await repository();
		const base = note(
			{ title: 'Shared', status: 'draft' },
			'line 1\nline 2\nline 3\n',
		);
		const seeded = await repo.write({
			files: [{ path: 'notes/shared.md', text: base }],
		});
		const baseBlob = seeded.body.blobs['notes/shared.md'] as string;
		let release!: () => void;
		const held = new Promise<void>((resolve) => {
			release = resolve;
		});
		// A reads main, then waits while B lands, so A's swap is stale and it retries.
		const a = repo.write(
			{
				files: [
					{
						path: 'notes/shared.md',
						base: baseBlob,
						text: note(
							{ title: 'Shared (A)', status: 'draft' },
							'line 1\nline 2 by A\nline 3\n',
						),
					},
				],
			},
			() => held,
		);
		await Bun.sleep(50);
		const b = await repo.write({
			files: [
				{
					path: 'notes/shared.md',
					base: baseBlob,
					text: note(
						{ title: 'Shared', status: 'done' },
						'line 1\nline 2\nline 3\nline 4 by B\n',
					),
				},
			],
		});
		release();
		const aDone = await a;
		expect(b.status).toBe(200);
		expect(aDone.status).toBe(200);
		expect(aDone.body.attempts).toBe(2);
		expect(aDone.body.outcomes[0]?.outcome).toBe('merged');
		expect(await repo.show('notes/shared.md')).toBe(
			note(
				{ title: 'Shared (A)', status: 'done' },
				'line 1\nline 2 by A\nline 3\nline 4 by B\n',
			),
		);
		expect(
			(
				await box.ok(repo.gitDir, ['rev-list', '--merges', '--count', 'main'])
			).trim(),
		).toBe('0');
		expect(
			(await box.ok(repo.gitDir, ['rev-list', '--count', 'main'])).trim(),
		).toBe('3');
	});

	test('one key and one line both changed: the later arrival takes the key, the line gets one block', async () => {
		const repo = await repository();
		const seeded = await repo.write({
			files: [
				{ path: 'n.md', text: note({ title: 'T' }, 'one\ntwo\nthree\n') },
			],
		});
		const base = seeded.body.blobs['n.md'] as string;
		await repo.write({
			files: [
				{
					path: 'n.md',
					base,
					text: note({ title: 'C' }, 'one\nrewritten by C\nthree\n'),
				},
			],
		});
		const late = await repo.write({
			files: [
				{
					path: 'n.md',
					base,
					text: note({ title: 'E' }, 'one\nrewritten by E\nthree\n'),
				},
			],
		});
		expect(late.body.outcomes[0]?.outcome).toBe('conflict');
		const text = await repo.show('n.md');
		expect(text.startsWith('---\ntitle: E\n---\n')).toBe(true);
		expect(text.match(/^<<<<<<< /gm)).toHaveLength(1);
		expect(text).toContain('rewritten by E');
		expect(text).toContain('rewritten by C');
	});

	test("the incoming note's key order stays, and keys only main has are appended (decision 47)", async () => {
		const repo = await repository();
		const seeded = await repo.write({
			files: [
				{ path: 'k.md', text: note({ title: 'T', status: 'a' }, 'body\n') },
			],
		});
		const base = seeded.body.blobs['k.md'] as string;
		await repo.write({
			files: [
				{
					path: 'k.md',
					base,
					text: note({ title: 'T', status: 'a', added: 'by main' }, 'body\n'),
				},
			],
		});
		await repo.write({
			files: [
				{
					path: 'k.md',
					base,
					text: note({ status: 'b', title: 'T', mood: 'x' }, 'body\n'),
				},
			],
		});
		expect(await repo.show('k.md')).toBe(
			note({ status: 'b', title: 'T', mood: 'x', added: 'by main' }, 'body\n'),
		);
	});

	test('a racing binary replace lands beside it as a conflict copy', async () => {
		const repo = await repository();
		const first = await upload(repo, new TextEncoder().encode('first take'));
		const mine = await upload(repo, new TextEncoder().encode('my take'));
		const theirs = await upload(repo, new TextEncoder().encode('their take'));
		const seeded = await repo.write({
			files: [{ path: 'r/a.m4a', lfs: first }],
		});
		const base = seeded.body.blobs['r/a.m4a'] as string;
		await repo.write({ files: [{ path: 'r/a.m4a', base, lfs: theirs }] });
		const lost = await repo.write({
			files: [{ path: 'r/a.m4a', base, lfs: mine }],
		});
		const sibling = conflictSibling('r/a.m4a', mine.oid);
		expect(lost.body.outcomes[0]).toEqual({
			path: 'r/a.m4a',
			landed: sibling,
			outcome: 'conflict-copy',
		});
		expect(await repo.show('r/a.m4a')).toContain(theirs.oid);
		expect(await repo.show(sibling)).toContain(mine.oid);
		// Writing the same bytes again (with no base) changes nothing.
		const again = await repo.write({
			files: [{ path: 'r/a.m4a', lfs: theirs }],
		});
		expect(again.body.outcomes[0]?.outcome).toBe('unchanged');
	});

	test('an edit beats a delete, both ways', async () => {
		const repo = await repository();
		const seeded = await repo.write({
			files: [{ path: 'd.md', text: note({ title: 'D' }, 'x\n') }],
		});
		const base = seeded.body.blobs['d.md'] as string;
		await repo.write({
			files: [{ path: 'd.md', base, text: note({ title: 'Edited' }, 'x\n') }],
		});
		const deleted = await repo.write({
			files: [{ path: 'd.md', base, delete: true }],
		});
		expect(deleted.body.outcomes[0]?.outcome).toBe('kept');
		expect(await repo.show('d.md')).toContain('Edited');

		const current = (
			await repo.write({ files: [{ path: 'e.md', text: 'e\n' }] })
		).body.blobs['e.md'] as string;
		const gone = await repo.write({
			files: [{ path: 'e.md', base: current, delete: true }],
		});
		expect(gone.body.outcomes[0]?.outcome).toBe('deleted');
		const back = await repo.write({
			files: [{ path: 'e.md', base: current, text: 'e edited\n' }],
		});
		expect(back.body.outcomes[0]?.outcome).toBe('written');
		expect(await repo.show('e.md')).toBe('e edited\n');
	});

	test('two identical captures at once make one commit', async () => {
		const repo = await repository();
		await repo.write({ files: [{ path: 'seed.md', text: 'seed\n' }] });
		let release!: () => void;
		const held = new Promise<void>((resolve) => {
			release = resolve;
		});
		const request = {
			captureId: 'cap-dup',
			files: [{ path: 'c/1.md', text: 'one\n' }],
		};
		const both = [
			repo.write(request, () => held),
			repo.write(request, () => held),
		];
		await Bun.sleep(50);
		release();
		const [a, b] = await Promise.all(both);
		expect(a?.body.commit).toBe(b?.body.commit as string);
		expect([a?.body.replayed, b?.body.replayed].filter(Boolean)).toHaveLength(
			1,
		);
		expect(
			(await box.ok(repo.gitDir, ['rev-list', '--count', 'main'])).trim(),
		).toBe('2');
	});

	test('a receipt whose commit left main lands the capture again (decision 50)', async () => {
		const repo = await repository();
		await repo.write({ files: [{ path: 'seed.md', text: 'seed\n' }] });
		const seed = await repo.main();
		const request = {
			captureId: 'cap-r',
			files: [{ path: 'c/r.md', text: 'kept\n' }],
		};
		const landed = await repo.write(request);
		// An owner's rewrite drops the capture's commit from main.
		expect(
			await repo.objects.apply(
				[{ ref: MAIN, old: landed.body.commit, next: seed }],
				null,
			),
		).toEqual({ ok: true });
		const relanded = await repo.write(request);
		expect(relanded.body.replayed).toBeUndefined();
		expect(await repo.main()).toBe(relanded.body.commit);
		expect(await repo.show('c/r.md')).toBe('kept\n');
		expect((await repo.objects.refs()).get(captureRef('cap-r'))).toBe(
			relanded.body.commit,
		);

		// A rewrite that keeps the files (a reworded tip) needs no new commit.
		const tip = await readCommit(repo.objects, relanded.body.commit);
		const reworded = await box.ok(repo.gitDir, [
			'commit-tree',
			tip?.tree as string,
			'-p',
			seed,
			'-m',
			'reworded',
		]);
		await repo.objects.apply(
			[{ ref: MAIN, old: relanded.body.commit, next: reworded.trim() }],
			null,
		);
		const replay = await repo.write(request);
		expect(replay.body.commit).toBe(reworded.trim());
		expect(await repo.main()).toBe(reworded.trim());
		expect((await repo.objects.refs()).get(captureRef('cap-r'))).toBe(
			reworded.trim(),
		);
	});
});

describe('GET files and file', () => {
	test('lists a folder with each pointer, and reads a note or a pointer', async () => {
		const repo = await repository();
		const audio = await upload(repo, new TextEncoder().encode('sound'));
		await repo.write({
			files: [
				{ path: 'rec/a.md', text: 'note\n' },
				{ path: 'rec/a.webm', lfs: audio },
				{ path: 'other/b.md', text: 'b\n' },
			],
		});
		const listed = (await (
			await listRepositoryFiles(repo.objects, 'rec')
		).json()) as {
			files: { path: string; lfs?: unknown }[];
		};
		expect(listed.files.map((f) => f.path)).toEqual(['rec/a.md', 'rec/a.webm']);
		expect(listed.files[1]?.lfs).toEqual(audio);
		const read = (await (
			await readRepositoryFile(repo.objects, 'rec/a.md')
		).json()) as {
			text: string;
		};
		expect(read.text).toBe('note\n');
		expect((await readRepositoryFile(repo.objects, 'rec/none.md')).status).toBe(
			404,
		);
		const empty = await repository();
		expect(
			(await (await listRepositoryFiles(empty.objects, '')).json()) as unknown,
		).toEqual({
			commit: null,
			files: [],
		});
	});
});
