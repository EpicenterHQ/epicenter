/**
 * A folder's sync routes (`folder.ts`) against the disk store and a real
 * bare repository, in Git's vocabulary: one commit per request, every path
 * landing only where it still holds the blob its writer expects (null for
 * nothing), checked in the step that moves `main`; the tree at a commit;
 * blobs by id; an attachment's bytes by its sha256; and the upload ledger's
 * sweep. The server never merges (ADR-0773).
 *
 * Key behaviors:
 * - A commit lands every file or none; a path that moved answers `moved`
 *   with what it holds, and a resend after a lost reply finds its own bytes
 * - A path differing only in case from one held is refused
 * - `changes` names the paths whose blob differs since a commit; `tree`
 *   answers blob ids at a commit, an attachment's with its object and size
 * - An attachment's bytes are put once, checked against their hash, pending
 *   until a commit keeps them, and swept a day after if none does
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
import { sweepPendingUploads, type UploadLedger } from '../uploads.js';
import {
	folderBlobs,
	folderChanges,
	folderCommit,
	folderTree,
	getAttachment,
	putAttachment,
	readCommitRequest,
} from './folder.js';

let box: GitSandbox;
let host: ReturnType<typeof createDiskGitHost>;
let lfs: LfsStore;
const author = { name: 'Sync', email: 'sync@example.test' };

beforeAll(async () => {
	box = await createGitSandbox();
	host = createDiskGitHost({ root: join(box.root, 'store') });
	lfs = createDiskLfsStore({ root: join(box.root, 'lfs') });
});
afterAll(async () => {
	await rm(box.root, { recursive: true, force: true });
});

type Receipt = {
	commit: string | null;
	blobs: Record<string, string | null>;
	error?: string;
	path?: string;
	now?: string | null;
};

/** A ledger in memory: pending uploads by `<repository>:<oid>`, with when. */
function memoryLedger() {
	const pending = new Map<string, Date>();
	const ledger: UploadLedger = {
		async pending(repositoryId, oid) {
			if (!pending.has(`${repositoryId}:${oid}`))
				pending.set(`${repositoryId}:${oid}`, new Date());
		},
		async keep(repositoryId, oids) {
			for (const oid of oids) pending.delete(`${repositoryId}:${oid}`);
		},
		async expire(cutoff) {
			const out: { repositoryId: string; oid: string }[] = [];
			for (const [key, at] of pending)
				if (at < cutoff) {
					pending.delete(key);
					const [repositoryId = '', oid = ''] = key.split(':');
					out.push({ repositoryId, oid });
				}
			return out;
		},
	};
	return { ledger, pending };
}

async function repository(ledger: UploadLedger | null = null) {
	const id = newRepositoryId();
	await host.create(id);
	const objects: GitObjects = host.objects(id);
	const gitDir = repositoryPath(join(box.root, 'store'), id);
	return {
		id,
		objects,
		gitDir,
		async commit(
			files: unknown[],
			hold?: () => Promise<void>,
		): Promise<{ status: number; body: Receipt }> {
			const checked = readCommitRequest({ files });
			if (!Array.isArray(checked))
				return { status: 400, body: checked as never };
			const response = await folderCommit({
				objects: host.objects(id),
				lfs,
				ledger,
				repositoryId: id,
				files: checked,
				author,
				hold,
			});
			return { status: response.status, body: await response.json() };
		},
		async main() {
			return (await objects.refs()).get(MAIN) ?? ZERO_OID;
		},
		show(path: string) {
			return box.ok(gitDir, ['show', `main:${path}`]);
		},
		count: async () =>
			(await box.ok(gitDir, ['rev-list', '--count', 'main'])).trim(),
	};
}
type Repo = Awaited<ReturnType<typeof repository>>;

async function upload(repo: Repo, bytes: Uint8Array) {
	const oid = createHash('sha256').update(bytes).digest('hex');
	await lfs.put(repo.id, oid, new Blob([bytes as BlobPart]).stream());
	return { oid, size: bytes.length };
}

const note = (title: string, body = '') => `---\ntitle: ${title}\n---\n${body}`;

/** A pending gate: `wait` answers once `release` is called. */
function gate() {
	let release!: () => void;
	const held = new Promise<void>((resolve) => {
		release = resolve;
	});
	return { wait: () => held, release };
}

describe('POST commits', () => {
	test('a capture (note plus audio) is one commit, and its reply names both blobs', async () => {
		const repo = await repository();
		const audio = new TextEncoder().encode('RIFF fake audio');
		const object = {
			oid: createHash('sha256').update(audio).digest('hex'),
			size: audio.length,
		};
		const files = [
			{ path: 'recordings/a.md', expect: null, text: note('Standup', 'Hi\n') },
			{ path: 'recordings/a.webm', expect: null, lfs: object },
		];
		const before = await repo.commit(files);
		expect(before).toMatchObject({
			status: 409,
			body: { error: 'not_uploaded', path: 'recordings/a.webm' },
		});
		expect(await repo.main()).toBe(ZERO_OID);

		await upload(repo, audio);
		const landed = await repo.commit(files);
		expect(landed.status).toBe(200);
		expect(await repo.main()).toBe(landed.body.commit as string);
		expect(await repo.count()).toBe('1');
		for (const path of ['recordings/a.md', 'recordings/a.webm'])
			expect(landed.body.blobs[path]).toBe(
				(await box.ok(repo.gitDir, ['rev-parse', `main:${path}`])).trim(),
			);
		expect(await repo.show('recordings/a.webm')).toBe(
			`version https://git-lfs.github.com/spec/v1\noid sha256:${object.oid}\nsize ${object.size}\n`,
		);
		expect(await repo.show('.gitattributes')).toBe(REPOSITORY_ATTRIBUTES);
		// The server keeps nothing about the request: main is the only ref.
		expect([...(await repo.objects.refs()).keys()]).toEqual([MAIN]);
	});

	test('a resend after a lost reply has moved, to its own bytes, and nothing moves', async () => {
		const repo = await repository();
		const files = [{ path: 'r/a.md', expect: null, text: note('Standup') }];
		const landed = await repo.commit(files);
		const resent = await repo.commit(files);
		expect(resent).toMatchObject({
			status: 409,
			body: {
				error: 'moved',
				path: 'r/a.md',
				now: landed.body.blobs['r/a.md'],
			},
		});
		expect(await repo.main()).toBe(landed.body.commit as string);
	});

	test('the bytes a path holds, over their own blob, land as nothing: no commit', async () => {
		const repo = await repository();
		const text = note('Same', 'x\n');
		const landed = await repo.commit([{ path: 's.md', expect: null, text }]);
		const blob = landed.body.blobs['s.md'] as string;
		const again = await repo.commit([{ path: 's.md', expect: blob, text }]);
		expect(again).toMatchObject({
			status: 200,
			body: { commit: landed.body.commit, blobs: { 's.md': blob } },
		});
		expect(await repo.count()).toBe('1');
	});

	test('a note takes bytes as text or base64, an attachment only as an uploaded object', async () => {
		const repo = await repository();
		const bytes = new Uint8Array([0xff, 0xfe, 0x0a]);
		const landed = await repo.commit([
			{
				path: 'n/raw.md',
				expect: null,
				base64: Buffer.from(bytes).toString('base64'),
			},
			{ path: '.hidden/settings.json', expect: null, text: '{}\n' },
		]);
		expect(landed.status).toBe(200);
		expect(landed.body.blobs['n/raw.md']).toBe(
			(await box.ok(repo.gitDir, ['rev-parse', 'main:n/raw.md'])).trim(),
		);
		const refused = async (files: unknown[]) =>
			(await repo.commit(files)).status;
		expect(await refused([{ path: 'a.webm', expect: null, text: 'raw' }])).toBe(
			400,
		);
		expect(
			await refused([
				{ path: 'a.MD', expect: null, lfs: { oid: 'a'.repeat(64), size: 1 } },
			]),
		).toBe(400);
		expect(await refused([{ path: '../a.md', expect: null, text: 'x' }])).toBe(
			400,
		);
		expect(
			await refused([{ path: '.git/config', expect: null, text: 'x' }]),
		).toBe(400);
		// Every file names what its writer expects there.
		expect(await refused([{ path: 'a.md', text: 'x' }])).toBe(400);
		expect(
			await refused([
				{ path: 'a.md', expect: null, text: 'x' },
				{ path: 'a.md', expect: null, text: 'y' },
			]),
		).toBe(400);
	});

	test('of two commits over one blob, the later has moved in the step that moves main, and nothing merges', async () => {
		const repo = await repository();
		const seeded = await repo.commit([
			{ path: 'notes/shared.md', expect: null, text: note('Shared') },
		]);
		const base = seeded.body.blobs['notes/shared.md'] as string;
		const held = gate();
		// A reads main, then waits while B lands, so A's swap finds main moved;
		// its retry finds the path moved and refuses.
		const a = repo.commit(
			[{ path: 'notes/shared.md', expect: base, text: note('From A') }],
			held.wait,
		);
		await Bun.sleep(50);
		const b = await repo.commit([
			{ path: 'notes/shared.md', expect: base, text: note('From B') },
		]);
		held.release();
		expect(b.status).toBe(200);
		expect(await a).toMatchObject({
			status: 409,
			body: {
				error: 'moved',
				path: 'notes/shared.md',
				now: b.body.blobs['notes/shared.md'],
			},
		});
		expect(await repo.show('notes/shared.md')).toBe(note('From B'));
		expect(await repo.count()).toBe('2');
	});

	test('a delete of a file changed since, and an edit of a file deleted since, have moved', async () => {
		const repo = await repository();
		const seeded = await repo.commit([
			{ path: 'd.md', expect: null, text: 'd\n' },
		]);
		const base = seeded.body.blobs['d.md'] as string;
		await repo.commit([{ path: 'd.md', expect: base, text: 'edited\n' }]);
		const deleted = await repo.commit([
			{ path: 'd.md', expect: base, delete: true },
		]);
		expect(deleted).toMatchObject({ status: 409, body: { error: 'moved' } });

		const current = (
			await repo.commit([{ path: 'e.md', expect: null, text: 'e\n' }])
		).body.blobs['e.md'] as string;
		const gone = await repo.commit([
			{ path: 'e.md', expect: current, delete: true },
		]);
		expect(gone).toMatchObject({
			status: 200,
			body: { blobs: { 'e.md': null } },
		});
		const back = await repo.commit([
			{ path: 'e.md', expect: current, text: 'again\n' },
		]);
		expect(back).toMatchObject({
			status: 409,
			body: { error: 'moved', now: null },
		});
	});

	test('a path differing only in case from one held is refused, and a case-only rename lands in one commit', async () => {
		const repo = await repository();
		const seeded = await repo.commit([
			{ path: 'todos/a.md', expect: null, text: 'a\n' },
		]);
		for (const [written, path, held] of [
			['todos/A.md', 'todos/A.md', 'todos/a.md'],
			['Todos/b.md', 'Todos', 'todos'],
		] as const)
			expect(
				await repo.commit([{ path: written, expect: null, text: 'clash\n' }]),
			).toMatchObject({
				status: 409,
				body: { error: 'case_collision', path, held },
			});
		expect(await repo.main()).toBe(seeded.body.commit as string);
		const renamed = await repo.commit([
			{
				path: 'todos/a.md',
				expect: seeded.body.blobs['todos/a.md'],
				delete: true,
			},
			{ path: 'todos/A.md', expect: null, text: 'a\n' },
		]);
		expect(renamed.status).toBe(200);
		expect(await repo.show('todos/A.md')).toBe('a\n');
	});
});

describe('changes, tree and blobs', () => {
	test('changes names the paths whose blob differs since a commit, and null for one the repository never held', async () => {
		const repo = await repository();
		const changes = async (since?: string) =>
			(await (await folderChanges(repo.objects, since)).json()) as unknown;
		expect(await changes()).toEqual({ commit: null, paths: null });
		const first = await repo.commit([
			{ path: 'a.md', expect: null, text: 'a\n' },
			{ path: 'dir/b.md', expect: null, text: 'b\n' },
		]);
		const at = first.body.commit as string;
		expect(await changes(at)).toEqual({ commit: at, paths: [] });
		const second = await repo.commit([
			{ path: 'dir/b.md', expect: first.body.blobs['dir/b.md'], text: 'B\n' },
			{ path: 'dir/c/d.md', expect: null, text: 'd\n' },
			{ path: 'a.md', expect: first.body.blobs['a.md'], delete: true },
		]);
		expect(await changes(at)).toEqual({
			commit: second.body.commit,
			paths: ['a.md', 'dir/b.md', 'dir/c/d.md'],
		});
		expect(await changes('0'.repeat(40))).toEqual({
			commit: second.body.commit,
			paths: null,
		});
	});

	test('tree answers blob ids at a commit, an attachment with its object, and blobs answers bytes by id', async () => {
		const repo = await repository();
		const audio = await upload(repo, new TextEncoder().encode('sound'));
		const first = await repo.commit([
			{ path: 'rec/a.md', expect: null, text: 'note\n' },
			{ path: 'rec/a.webm', expect: null, lfs: audio },
		]);
		const second = await repo.commit([
			{
				path: 'rec/a.md',
				expect: first.body.blobs['rec/a.md'],
				text: 'edited\n',
			},
		]);
		const tree = async (body: unknown) => {
			const response = await folderTree(repo.objects, body);
			return {
				status: response.status,
				body: (await response.json()) as unknown,
			};
		};
		expect((await tree({ commit: first.body.commit })).body).toEqual({
			commit: first.body.commit,
			entries: [
				{ path: '.gitattributes', blob: expect.any(String) },
				{ path: 'rec/a.md', blob: first.body.blobs['rec/a.md'] },
				{ path: 'rec/a.webm', blob: first.body.blobs['rec/a.webm'], ...audio },
			],
		});
		expect(
			(
				await tree({
					commit: second.body.commit,
					paths: ['rec/a.md', 'rec/none.md'],
				})
			).body,
		).toEqual({
			commit: second.body.commit,
			entries: [{ path: 'rec/a.md', blob: second.body.blobs['rec/a.md'] }],
		});
		expect((await tree({ commit: '0'.repeat(40) })).status).toBe(404);
		expect((await tree({ commit: 'main' })).status).toBe(400);

		const blobs = (await (
			await folderBlobs(repo.objects, {
				ids: [first.body.blobs['rec/a.md'], 'f'.repeat(40)],
			})
		).json()) as { blobs: (string | null)[] };
		expect(blobs.blobs).toEqual([
			Buffer.from('note\n').toString('base64'),
			null,
		]);
	});
});

describe('attachments and the upload ledger', () => {
	test('an attachment is put once, checked against its hash, read back immutable, and kept by the commit that names it', async () => {
		const { ledger, pending } = memoryLedger();
		const repo = await repository(ledger);
		const bytes = new TextEncoder().encode('a take');
		const oid = createHash('sha256').update(bytes).digest('hex');
		const put = (body: Uint8Array, as = oid) =>
			putAttachment({
				lfs,
				ledger,
				repositoryId: repo.id,
				oid: as,
				request: new Request('http://x/', {
					method: 'PUT',
					body: body as BodyInit,
					headers: { 'content-length': String(body.byteLength) },
				}),
			});
		expect((await put(new TextEncoder().encode('not it'))).status).toBe(422);
		expect((await put(bytes)).status).toBe(201);
		expect([...pending.keys()]).toEqual([`${repo.id}:${oid}`]);
		// Idempotent: a resend after a lost reply finds it held.
		expect((await put(bytes)).status).toBe(200);
		const got = await getAttachment(lfs, repo.id, oid);
		expect(got.headers.get('cache-control')).toBe(
			'private, max-age=31536000, immutable',
		);
		expect(await got.text()).toBe('a take');
		await repo.commit([
			{ path: 'a.webm', expect: null, lfs: { oid, size: bytes.byteLength } },
		]);
		expect(pending.size).toBe(0);
	});

	test('the sweep deletes the bytes of an upload no commit kept for a day, and nothing kept', async () => {
		const { ledger } = memoryLedger();
		const repo = await repository(ledger);
		const stray = await upload(repo, new TextEncoder().encode('stray'));
		const kept = await upload(repo, new TextEncoder().encode('kept'));
		await ledger.pending(repo.id, stray.oid);
		await ledger.pending(repo.id, kept.oid);
		await repo.commit([{ path: 'k.webm', expect: null, lfs: kept }]);
		const later = new Date(Date.now() + 25 * 60 * 60 * 1000);
		expect(await sweepPendingUploads({ ledger, lfs, now: new Date() })).toBe(0);
		expect(await sweepPendingUploads({ ledger, lfs, now: later })).toBe(1);
		expect(await lfs.verified(repo.id, stray)).toBe(false);
		expect(await lfs.verified(repo.id, kept)).toBe(true);
	});
});
