/**
 * The write translator against the disk store and a real bare repository:
 * one commit per request, the note merge, conflict copies, an edit beating
 * a delete, and a resend after a lost reply judged like any write
 * (decision 68).
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import { rm } from 'node:fs/promises';
import { join } from 'node:path';
import { REPOSITORY_ATTRIBUTES } from '@epicenter/definition/contract';
import { conflictSibling } from '@epicenter/definition/merge';
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
		const files = [
			{ path: 'recordings/a.md', text: note({ title: 'Standup' }, 'Hello\n') },
			{ path: 'recordings/a.webm', lfs: { oid: 'x', size: 0 } },
		];
		const object = {
			oid: createHash('sha256').update(audio).digest('hex'),
			size: audio.length,
		};
		files[1] = { path: 'recordings/a.webm', lfs: object };
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

	test('a plain resend after a lost reply lands as nothing: same blobs, no new commit', async () => {
		const repo = await repository();
		const audio = await upload(repo, new TextEncoder().encode('sound'));
		const files = [
			{ path: 'r/a.md', text: note({ title: 'Standup' }, 'Hello\n') },
			{ path: 'r/a.webm', lfs: audio },
		];
		const landed = await repo.write({ files });
		const resent = await repo.write({ files });
		expect(resent.status).toBe(200);
		expect(resent.body).toMatchObject({
			commit: landed.body.commit,
			paths: landed.body.paths,
			blobs: landed.body.blobs,
		});
		expect(resent.body.outcomes.map((o) => o.outcome)).toEqual([
			'unchanged',
			'unchanged',
		]);
		expect(await repo.main()).toBe(landed.body.commit);
		expect(
			(await box.ok(repo.gitDir, ['rev-list', '--count', 'main'])).trim(),
		).toBe('1');
	});

	test('a lost reply, an edit, then a resend: the note gets one conflict block and nothing is lost', async () => {
		const repo = await repository();
		const first = note({ title: 'Standup' }, 'first take\n');
		const landed = await repo.write({
			files: [{ path: 'c/x.md', text: first }],
		});
		expect(landed.status).toBe(200);
		// The reply was lost; the person edited the still-pending note, and
		// the device sends the same create with what it holds now.
		const edited = note({ title: 'Retro' }, 'second take\n');
		const resent = await repo.write({
			files: [{ path: 'c/x.md', text: edited }],
		});
		expect(resent.status).toBe(200);
		expect(resent.body.outcomes[0]?.outcome).toBe('conflict');
		const text = await repo.show('c/x.md');
		expect(text.match(/^<<<<<<< /gm)).toHaveLength(1);
		expect(text.startsWith(first)).toBe(true);
		for (const line of ['title: Retro', 'second take'])
			expect(text).toContain(line);
		expect(resent.body.blobs['c/x.md']).toBe(
			(await box.ok(repo.gitDir, ['rev-parse', 'main:c/x.md'])).trim(),
		);
	});

	test('a binary resent with other bytes lands beside the first as a conflict copy', async () => {
		const repo = await repository();
		const take1 = await upload(repo, new TextEncoder().encode('take one'));
		const take2 = await upload(repo, new TextEncoder().encode('take two'));
		await repo.write({ files: [{ path: 'r/a.m4a', lfs: take1 }] });
		const resent = await repo.write({
			files: [{ path: 'r/a.m4a', lfs: take2 }],
		});
		const sibling = conflictSibling('r/a.m4a', take2.oid);
		expect(resent.body.outcomes[0]).toEqual({
			path: 'r/a.m4a',
			landed: sibling,
			outcome: 'conflict-copy',
		});
		expect(await repo.show('r/a.m4a')).toContain(take1.oid);
		expect(await repo.show(sibling)).toContain(take2.oid);
	});

	test("a repository's first commit holds the standard .gitattributes (decision 59)", async () => {
		const repo = await repository();
		const first = await repo.write({
			files: [{ path: 'recordings/a.md', text: 'a\n' }],
		});
		expect(await repo.show('.gitattributes')).toBe(REPOSITORY_ATTRIBUTES);
		// The reply names the request's files only.
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
		).toBe('Web write: 1 file');

		// A first write that brings its own keeps it.
		const own = await repository();
		await own.write({
			files: [{ path: '.gitattributes', text: '*.bin filter=lfs\n' }],
		});
		expect(await own.show('.gitattributes')).toBe('*.bin filter=lfs\n');
	});

	test('a .MD path is a note in any case: it takes text and merges by line', async () => {
		const repo = await repository();
		const seeded = await repo.write({
			files: [{ path: 'n/Shout.MD', text: 'one\ntwo\n' }],
		});
		expect(seeded.status).toBe(200);
		const base = seeded.body.blobs['n/Shout.MD'] as string;
		await repo.write({
			files: [{ path: 'n/Shout.MD', base, text: 'ONE\ntwo\n' }],
		});
		const raced = await repo.write({
			files: [{ path: 'n/Shout.MD', base, text: 'one\nTWO\n' }],
		});
		expect(raced.body.outcomes[0]?.outcome).toBe('merged');
		expect(await repo.show('n/Shout.MD')).toBe('ONE\nTWO\n');
		const lfsWrite = readWriteRequest({
			files: [{ path: 'n/a.MD', lfs: { oid: 'a'.repeat(64), size: 1 } }],
		});
		expect('status' in lfsWrite && lfsWrite.status).toBe(400);
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

	test('a binary edit beats a delete too: the edited file is back at its path (decision 15)', async () => {
		const repo = await repository();
		const first = await upload(repo, new TextEncoder().encode('take one'));
		const seeded = await repo.write({
			files: [{ path: 'r/a.m4a', lfs: first }],
		});
		const base = seeded.body.blobs['r/a.m4a'] as string;
		const deleted = await repo.write({
			files: [{ path: 'r/a.m4a', base, delete: true }],
		});
		expect(deleted.body.outcomes[0]?.outcome).toBe('deleted');
		const second = await upload(repo, new TextEncoder().encode('take two'));
		const edited = await repo.write({
			files: [{ path: 'r/a.m4a', base, lfs: second }],
		});
		expect(edited.body.outcomes[0]).toEqual({
			path: 'r/a.m4a',
			landed: 'r/a.m4a',
			outcome: 'written',
		});
		expect(await repo.show('r/a.m4a')).toContain(second.oid);
	});

	test('two identical creates at once make one commit', async () => {
		const repo = await repository();
		await repo.write({ files: [{ path: 'seed.md', text: 'seed\n' }] });
		let release!: () => void;
		const held = new Promise<void>((resolve) => {
			release = resolve;
		});
		const request = { files: [{ path: 'c/1.md', text: 'one\n' }] };
		const both = [
			repo.write(request, () => held),
			repo.write(request, () => held),
		];
		await Bun.sleep(50);
		release();
		const [a, b] = await Promise.all(both);
		expect(a?.body.commit).toBe(b?.body.commit as string);
		expect(
			[a?.body.outcomes[0]?.outcome, b?.body.outcomes[0]?.outcome].sort(),
		).toEqual(['unchanged', 'written']);
		expect(
			(await box.ok(repo.gitDir, ['rev-list', '--count', 'main'])).trim(),
		).toBe('2');
	});

	test("a resend after an owner's rewrite dropped the first landing lands it again", async () => {
		const repo = await repository();
		await repo.write({ files: [{ path: 'seed.md', text: 'seed\n' }] });
		const seed = await repo.main();
		const request = { files: [{ path: 'c/r.md', text: 'kept\n' }] };
		const landed = await repo.write(request);
		expect(
			await repo.objects.apply(
				[{ ref: MAIN, old: landed.body.commit, next: seed }],
				null,
			),
		).toEqual({ ok: true });
		const relanded = await repo.write(request);
		expect(relanded.body.outcomes[0]?.outcome).toBe('written');
		expect(await repo.main()).toBe(relanded.body.commit);
		expect(await repo.show('c/r.md')).toBe('kept\n');
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
