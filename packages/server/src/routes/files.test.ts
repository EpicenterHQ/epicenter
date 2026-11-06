/**
 * The write translator against the disk store and a real bare repository:
 * one commit per request, every file landing only over the blob its writer
 * read (null for nothing), checked in the step that moves `main`, and a
 * resend after a lost reply judged like any write (decision 68). The server
 * never merges (ADR-0773).
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import { rm } from 'node:fs/promises';
import { join } from 'node:path';
import { REPOSITORY_ATTRIBUTES } from '@epicenter/definition/contract';
import { type GitObjects, MAIN, ZERO_OID } from '../git/objects.js';
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
	listRepositoryFiles,
	type Receipt,
	readRepositoryChanges,
	readRepositoryFiles,
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
	const objects = host.objects(id);
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
				objects: host.objects(id),
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
	test('a capture (note plus audio) is one commit, and its reply names both blobs', async () => {
		const repo = await repository();
		const audio = new TextEncoder().encode('RIFF fake audio');
		const object = {
			oid: createHash('sha256').update(audio).digest('hex'),
			size: audio.length,
		};
		const files = [
			{
				path: 'recordings/a.md',
				base: null,
				text: note({ title: 'Standup' }, 'Hello\n'),
			},
			{ path: 'recordings/a.webm', base: null, lfs: object },
		];
		const before = await repo.write({ files });
		expect(before.status).toBe(409);
		expect(before.body.error).toBe('lfs_not_uploaded');
		expect(await repo.main()).toBe(ZERO_OID);

		await upload(repo, audio);
		const landed = await repo.write({ files });
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
		// The server keeps nothing about the request: main is the only ref.
		expect([...(await repo.objects.refs()).keys()]).toEqual([MAIN]);
	});

	test('a resend after a lost reply is judged like any write: refused, and nothing moves', async () => {
		const repo = await repository();
		const audio = await upload(repo, new TextEncoder().encode('sound'));
		const files = [
			{
				path: 'r/a.md',
				base: null,
				text: note({ title: 'Standup' }, 'Hello\n'),
			},
			{ path: 'r/a.webm', base: null, lfs: audio },
		];
		const landed = await repo.write({ files });
		const resent = await repo.write({ files });
		expect(resent).toMatchObject({
			status: 409,
			body: { error: 'occupied', path: 'r/a.md' },
		});
		expect(await repo.main()).toBe(landed.body.commit);
	});

	test('writing the bytes a path holds over its own blob lands as nothing: no commit', async () => {
		const repo = await repository();
		const text = note({ title: 'Same' }, 'x\n');
		const landed = await repo.write({
			files: [{ path: 's.md', base: null, text }],
		});
		const blob = landed.body.blobs['s.md'] as string;
		const again = await repo.write({
			files: [{ path: 's.md', base: blob, text }],
		});
		expect(again.status).toBe(200);
		expect(again.body).toMatchObject({
			commit: landed.body.commit,
			blobs: { 's.md': blob },
		});
		expect(
			(await box.ok(repo.gitDir, ['rev-list', '--count', 'main'])).trim(),
		).toBe('1');
	});

	test("a repository's first commit holds the standard .gitattributes (decision 59)", async () => {
		const repo = await repository();
		const first = await repo.write({
			files: [{ path: 'recordings/a.md', base: null, text: 'a\n' }],
		});
		expect(await repo.show('.gitattributes')).toBe(REPOSITORY_ATTRIBUTES);
		// The reply names the request's files only.
		expect(first.body.paths).toEqual(['recordings/a.md']);
		// Later writes leave it alone.
		await repo.write({ files: [{ path: 'b.md', base: null, text: 'b\n' }] });
		expect(
			(
				await box.ok(repo.gitDir, [
					'log',
					'--format=%s',
					'--',
					'.gitattributes',
				])
			).trim(),
		).toBe('Web write: 1 file');

		// A first write that brings its own keeps it.
		const own = await repository();
		await own.write({
			files: [
				{ path: '.gitattributes', base: null, text: '*.bin filter=lfs\n' },
			],
		});
		expect(await own.show('.gitattributes')).toBe('*.bin filter=lfs\n');
	});

	test('a .MD path is a note in any case: it takes text, never LFS', async () => {
		const repo = await repository();
		const seeded = await repo.write({
			files: [{ path: 'n/Shout.MD', base: null, text: 'one\ntwo\n' }],
		});
		expect(seeded.status).toBe(200);
		expect(await repo.show('n/Shout.MD')).toBe('one\ntwo\n');
		const lfsWrite = readWriteRequest({
			files: [
				{ path: 'n/a.MD', base: null, lfs: { oid: 'a'.repeat(64), size: 1 } },
			],
		});
		expect('status' in lfsWrite && lfsWrite.status).toBe(400);
	});

	test('a hidden path takes text, being outside the contract (decision 58)', async () => {
		const repo = await repository();
		const written = await repo.write({
			files: [{ path: '.epicenter/settings.json', base: null, text: '{}\n' }],
		});
		expect(written.status).toBe(200);
	});

	test('refuses what a write may not hold', async () => {
		const repo = await repository();
		const refused = async (request: unknown) =>
			(await repo.write(request as WriteRequest)).status;
		expect(
			await refused({ files: [{ path: 'a.webm', base: null, text: 'raw' }] }),
		).toBe(400);
		expect(
			await refused({
				files: [
					{ path: 'a.md', base: null, lfs: { oid: 'a'.repeat(64), size: 1 } },
				],
			}),
		).toBe(400);
		expect(
			await refused({
				root: 'notes',
				files: [{ path: 'other/a.md', base: null, text: 'x' }],
			}),
		).toBe(400);
		expect(
			await refused({ files: [{ path: '../a.md', base: null, text: 'x' }] }),
		).toBe(400);
		expect(
			await refused({
				files: [{ path: '.git/config', base: null, text: 'x' }],
			}),
		).toBe(400);
		expect(await refused({ files: [{ path: 'a.md', delete: true }] })).toBe(
			400,
		);
		// Every write names what its writer read there.
		expect(await refused({ files: [{ path: 'a.md', text: 'x' }] })).toBe(400);
		expect(
			await refused({
				files: [
					{ path: 'a.md', base: null, text: 'x' },
					{ path: 'a.md', base: null, text: 'y' },
				],
			}),
		).toBe(400);
		expect(await repo.main()).toBe(ZERO_OID);
	});

	test('a create over nothing (base null) is refused where a file is, even one that raced it there', async () => {
		const repo = await repository();
		const audio = await upload(repo, new TextEncoder().encode('take'));
		const landed = await repo.write({
			files: [
				{ path: 'c/a.md', base: null, text: note({ title: 'First' }, '') },
				{ path: 'c/a.m4a', base: null, lfs: audio },
			],
		});
		expect(landed.status).toBe(200);
		const at = await repo.main();
		for (const file of [
			{ path: 'c/a.md', base: null, text: note({ title: 'First' }, '') },
			{ path: 'c/a.m4a', base: null, lfs: audio },
		]) {
			const again = await repo.write({ files: [file] });
			expect(again).toMatchObject({
				status: 409,
				body: { error: 'occupied', path: file.path },
			});
		}
		expect(
			(
				await repo.write({
					files: [{ path: 'c/a.md', base: null, delete: true }] as never,
				})
			).status,
		).toBe(400);

		// A reads main while c/b.md is free, then waits while B creates it, so
		// A's swap is stale; its retry finds the file and lands nothing.
		let release!: () => void;
		const held = new Promise<void>((resolve) => {
			release = resolve;
		});
		const a = repo.write(
			{
				files: [{ path: 'c/b.md', base: null, text: note({ title: 'A' }, '') }],
			},
			() => held,
		);
		await Bun.sleep(50);
		const b = await repo.write({
			files: [{ path: 'c/b.md', base: null, text: note({ title: 'B' }, '') }],
		});
		release();
		expect(b.status).toBe(200);
		expect(await a).toMatchObject({ status: 409, body: { error: 'occupied' } });
		expect(await repo.show('c/b.md')).toBe(note({ title: 'B' }, ''));
		expect(await repo.main()).toBe(b.body.commit);
		expect(at).not.toBe(b.body.commit);
	});

	test('of two writes from one base, the later is refused in the step that moves main, and nothing merges', async () => {
		const repo = await repository();
		const base = note({ title: 'Shared', status: 'draft' }, 'line 1\n');
		const seeded = await repo.write({
			files: [{ path: 'notes/shared.md', base: null, text: base }],
		});
		const baseBlob = seeded.body.blobs['notes/shared.md'] as string;
		let release!: () => void;
		const held = new Promise<void>((resolve) => {
			release = resolve;
		});
		// A reads main, then waits while B lands, so A's swap is stale; its
		// retry finds the path moved and refuses.
		const a = repo.write(
			{
				files: [
					{
						path: 'notes/shared.md',
						base: baseBlob,
						text: note({ title: 'Shared (A)', status: 'draft' }, 'line 1\n'),
					},
				],
			},
			() => held,
		);
		await Bun.sleep(50);
		const theirs = note({ title: 'Shared', status: 'done' }, 'line 1\n');
		const b = await repo.write({
			files: [{ path: 'notes/shared.md', base: baseBlob, text: theirs }],
		});
		release();
		expect(b.status).toBe(200);
		expect(await a).toMatchObject({
			status: 409,
			body: { error: 'stale', path: 'notes/shared.md' },
		});
		expect(await repo.show('notes/shared.md')).toBe(theirs);
		expect(await repo.main()).toBe(b.body.commit);
		expect(
			(await box.ok(repo.gitDir, ['rev-list', '--count', 'main'])).trim(),
		).toBe('2');
	});

	test('a file replaced over a blob it no longer holds is refused, and the bytes there stay', async () => {
		const repo = await repository();
		const first = await upload(repo, new TextEncoder().encode('first take'));
		const mine = await upload(repo, new TextEncoder().encode('my take'));
		const theirs = await upload(repo, new TextEncoder().encode('their take'));
		const seeded = await repo.write({
			files: [{ path: 'r/a.m4a', base: null, lfs: first }],
		});
		const base = seeded.body.blobs['r/a.m4a'] as string;
		const earlier = await repo.write({
			files: [{ path: 'r/a.m4a', base, lfs: theirs }],
		});
		const later = await repo.write({
			files: [{ path: 'r/a.m4a', base, lfs: mine }],
		});
		expect(later).toMatchObject({ status: 409, body: { error: 'stale' } });
		expect(await repo.show('r/a.m4a')).toContain(theirs.oid);
		expect(await repo.main()).toBe(earlier.body.commit);
	});

	test('a delete of a file changed since, and an edit of a file deleted since, are refused', async () => {
		const repo = await repository();
		const seeded = await repo.write({
			files: [{ path: 'd.md', base: null, text: note({ title: 'D' }, 'x\n') }],
		});
		const base = seeded.body.blobs['d.md'] as string;
		await repo.write({
			files: [{ path: 'd.md', base, text: note({ title: 'Edited' }, 'x\n') }],
		});
		const deleted = await repo.write({
			files: [{ path: 'd.md', base, delete: true }],
		});
		expect(deleted).toMatchObject({ status: 409, body: { error: 'stale' } });
		expect(await repo.show('d.md')).toContain('Edited');

		const current = (
			await repo.write({ files: [{ path: 'e.md', base: null, text: 'e\n' }] })
		).body.blobs['e.md'] as string;
		const gone = await repo.write({
			files: [{ path: 'e.md', base: current, delete: true }],
		});
		expect(gone.status).toBe(200);
		expect(gone.body.blobs['e.md']).toBeNull();
		const back = await repo.write({
			files: [{ path: 'e.md', base: current, text: 'e edited\n' }],
		});
		expect(back).toMatchObject({ status: 409, body: { error: 'stale' } });
		expect(await repo.main()).toBe(gone.body.commit);
	});

	test('two identical creates at once: one lands, the other is occupied', async () => {
		const repo = await repository();
		await repo.write({
			files: [{ path: 'seed.md', base: null, text: 'seed\n' }],
		});
		let release!: () => void;
		const held = new Promise<void>((resolve) => {
			release = resolve;
		});
		const request = { files: [{ path: 'c/1.md', base: null, text: 'one\n' }] };
		const both = [
			repo.write(request, () => held),
			repo.write(request, () => held),
		];
		await Bun.sleep(50);
		release();
		const [a, b] = await Promise.all(both);
		expect([a?.status, b?.status].sort()).toEqual([200, 409]);
		expect(
			(await box.ok(repo.gitDir, ['rev-list', '--count', 'main'])).trim(),
		).toBe('2');
	});

	test('a path differing only in case from one held is refused, a file or a folder, and nothing moves', async () => {
		const repo = await repository();
		const seeded = await repo.write({
			files: [{ path: 'todos/a.md', base: null, text: 'a\n' }],
		});
		for (const [written, path, held] of [
			['todos/A.md', 'todos/A.md', 'todos/a.md'],
			['todos/a.MD', 'todos/a.MD', 'todos/a.md'],
			['Todos/b.md', 'Todos', 'todos'],
		] as const) {
			const refused = await repo.write({
				files: [{ path: written, base: null, text: 'clash\n' }],
			});
			expect(refused).toMatchObject({
				status: 409,
				body: { error: 'case_collision', path, held },
			});
		}
		// Two new names that clash with each other, in one write.
		const both = await repo.write({
			files: [
				{ path: 'notes/x.md', base: null, text: 'x\n' },
				{ path: 'notes/X.md', base: null, text: 'X\n' },
			],
		});
		expect(both).toMatchObject({
			status: 409,
			body: { error: 'case_collision' },
		});
		expect(await repo.main()).toBe(seeded.body.commit);
	});

	test('a rename that changes only case lands as a delete and a create in one write', async () => {
		const repo = await repository();
		const seeded = await repo.write({
			files: [{ path: 'todos/a.md', base: null, text: 'a\n' }],
		});
		const renamed = await repo.write({
			files: [
				{
					path: 'todos/a.md',
					delete: true,
					base: seeded.body.blobs['todos/a.md'] as string,
				},
				{ path: 'todos/A.md', base: null, text: 'a\n' },
			],
		});
		expect(renamed.status).toBe(200);
		expect(await repo.show('todos/A.md')).toBe('a\n');
	});

	test("a resend after an owner's rewrite dropped the first landing lands it again", async () => {
		const repo = await repository();
		await repo.write({
			files: [{ path: 'seed.md', base: null, text: 'seed\n' }],
		});
		const seed = await repo.main();
		const request = { files: [{ path: 'c/r.md', base: null, text: 'kept\n' }] };
		const landed = await repo.write(request);
		expect(
			await repo.objects.apply(
				[{ ref: MAIN, old: landed.body.commit, next: seed }],
				null,
			),
		).toEqual({ ok: true });
		const relanded = await repo.write(request);
		expect(relanded.status).toBe(200);
		expect(await repo.main()).toBe(relanded.body.commit);
		expect(await repo.show('c/r.md')).toBe('kept\n');
	});
});

describe('GET changes', () => {
	test('answers the commit main is at and the paths changed since a commit', async () => {
		const repo = await repository();
		const changes = async (since?: string) =>
			(await (await readRepositoryChanges(repo.objects, since)).json()) as {
				commit: string | null;
				paths: string[] | null;
			};
		expect(await changes()).toEqual({ commit: null, paths: null });
		expect(await changes('')).toEqual({ commit: null, paths: [] });
		const first = await repo.write({
			files: [
				{ path: 'a.md', base: null, text: 'a\n' },
				{ path: 'dir/b.md', base: null, text: 'b\n' },
			],
		});
		expect(await changes('')).toEqual({
			commit: first.body.commit,
			paths: ['.gitattributes', 'a.md', 'dir/b.md'],
		});
		expect(await changes(first.body.commit)).toEqual({
			commit: first.body.commit,
			paths: [],
		});
		const second = await repo.write({
			files: [
				{
					path: 'dir/b.md',
					base: first.body.blobs['dir/b.md'] ?? null,
					text: 'B\n',
				},
				{ path: 'dir/c/d.md', base: null, text: 'd\n' },
				{
					path: 'a.md',
					base: first.body.blobs['a.md'] as string,
					delete: true,
				},
			],
		});
		expect(await changes(first.body.commit)).toEqual({
			commit: second.body.commit,
			paths: ['a.md', 'dir/b.md', 'dir/c/d.md'],
		});
		// A commit this repository never held: the reader lists again.
		expect(await changes('0'.repeat(40))).toEqual({
			commit: second.body.commit,
			paths: null,
		});
	});
});

describe('GET files and POST read', () => {
	test('lists folders and files with each pointer, and reads many paths in one request', async () => {
		const repo = await repository();
		const audio = await upload(repo, new TextEncoder().encode('sound'));
		await repo.write({
			files: [
				{ path: 'rec/a.md', base: null, text: 'note\n' },
				{ path: 'rec/a.webm', base: null, lfs: audio },
				{ path: 'other/b.md', base: null, text: 'b\n' },
				{ path: 'third/c.md', base: null, text: 'c\n' },
			],
		});
		const list = async (roots: string[]) =>
			(
				(await (await listRepositoryFiles(repo.objects, roots)).json()) as {
					files: { path: string; lfs?: unknown }[];
				}
			).files;
		const listed = await list(['rec']);
		expect(listed.map((f) => f.path)).toEqual(['rec/a.md', 'rec/a.webm']);
		expect(listed[1]?.lfs).toEqual(audio);
		expect(
			(await list(['rec', 'other/b.md', 'rec/a.md', 'none'])).map(
				(f) => f.path,
			),
		).toEqual(['rec/a.md', 'rec/a.webm', 'other/b.md']);
		const read = (await (
			await readRepositoryFiles(repo.objects, {
				paths: ['rec/a.md', 'rec/none.md', 'rec/a.webm'],
			})
		).json()) as { files: Record<string, unknown>[] };
		expect(read.files[0]).toMatchObject({ path: 'rec/a.md', text: 'note\n' });
		expect(read.files[1]).toEqual({ path: 'rec/none.md', gone: true });
		expect(read.files[2]).toMatchObject({ path: 'rec/a.webm', lfs: audio });
		expect(
			(await readRepositoryFiles(repo.objects, { paths: ['../x'] })).status,
		).toBe(400);
		const empty = await repository();
		expect(
			(await (await listRepositoryFiles(empty.objects, [])).json()) as unknown,
		).toEqual({
			commit: null,
			files: [],
		});
	});

	test('reads paths as an earlier commit held them, and refuses a commit the repository does not hold', async () => {
		const repo = await repository();
		const first = await repo.write({
			files: [{ path: 'a.md', base: null, text: 'first\n' }],
		});
		const second = await repo.write({
			files: [
				{
					path: 'a.md',
					base: first.body.blobs['a.md'] ?? null,
					text: 'second\n',
				},
				{ path: 'b.md', base: null, text: 'b\n' },
			],
		});
		const read = async (at?: unknown) => {
			const response = await readRepositoryFiles(repo.objects, {
				paths: ['a.md', 'b.md'],
				at,
			});
			return {
				status: response.status,
				body: (await response.json()) as unknown,
			};
		};
		expect((await read(first.body.commit)).body).toEqual({
			commit: first.body.commit,
			files: [
				{ path: 'a.md', blob: first.body.blobs['a.md'], text: 'first\n' },
				{ path: 'b.md', gone: true },
			],
		});
		expect((await read()).body).toMatchObject({
			commit: second.body.commit,
			files: [{ text: 'second\n' }, { text: 'b\n' }],
		});
		expect((await read('0'.repeat(40))).status).toBe(404);
		expect((await read('main')).status).toBe(400);
	});
});
