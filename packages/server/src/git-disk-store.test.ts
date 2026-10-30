import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { rm } from 'node:fs/promises';
import { join } from 'node:path';
import {
	commitObject,
	type GitObjects,
	makeObject,
	type PackObject,
	treeObject,
	ZERO_OID,
} from './git/objects.js';
import { writePack } from './git/pack.js';
import { createDiskGitHost, repositoryPath } from './git-disk-store.js';
import { newRepositoryId } from './repositories.js';
import {
	createGitSandbox,
	type GitSandbox,
} from './test-helpers/sandbox-git.js';

let box: GitSandbox;
let host: ReturnType<typeof createDiskGitHost>;
beforeAll(async () => {
	box = await createGitSandbox();
	host = createDiskGitHost({ root: join(box.root, 'store') });
});
afterAll(async () => {
	await rm(box.root, { recursive: true, force: true });
});

async function fresh(): Promise<{ id: string; objects: GitObjects }> {
	const id = newRepositoryId();
	await host.create(id);
	const objects = host.objects?.(id);
	if (!objects) throw new Error('the disk host has objects');
	return { id, objects };
}

function commitOf(files: Record<string, string>, parents: string[] = []) {
	const blobs = Object.entries(files).map(
		([name, text]) => [name, makeObject('blob', text)] as const,
	);
	const tree = treeObject(
		blobs.map(([name, blob]) => ({ mode: '100644', name, oid: blob.oid })),
	);
	const commit = commitObject({
		tree: tree.oid,
		parents,
		author: { name: 'Web', email: 'web@example.test', at: new Date() },
		message: `${Object.keys(files).join(' ')}\n`,
	});
	const objects: PackObject[] = [...blobs.map(([, b]) => b), tree, commit];
	return { commit, objects, pack: writePack(objects) };
}

describe('disk GitObjects', () => {
	test('apply moves refs, then reads see the objects', async () => {
		const { objects } = await fresh();
		const one = commitOf({ 'a.md': 'one\n' });
		expect(
			await objects.apply(
				[{ ref: 'refs/heads/main', old: ZERO_OID, next: one.commit.oid }],
				one.pack,
			),
		).toEqual({ ok: true });
		expect((await objects.refs()).get('refs/heads/main')).toBe(one.commit.oid);
		const read = await objects.read(one.commit.oid, 'commit');
		expect(read?.bytes).toEqual(one.commit.bytes);
		expect(await objects.read(one.commit.oid, 'tree')).toBeNull();
		expect(await objects.read('f'.repeat(40), 'blob')).toBeNull();
		const big = await objects.read(one.objects[0]?.oid as string, 'blob', {
			maxBytes: 2,
		});
		expect(big).toEqual({ size: 4, bytes: null });
		objects.close();
	});

	test('a stale old value moves nothing, across every ref in the transaction', async () => {
		const { objects } = await fresh();
		const one = commitOf({ 'a.md': 'one\n' });
		await objects.apply(
			[{ ref: 'refs/heads/main', old: ZERO_OID, next: one.commit.oid }],
			one.pack,
		);
		const a = commitOf({ 'a.md': 'a\n' }, [one.commit.oid]);
		const b = commitOf({ 'a.md': 'b\n' }, [one.commit.oid]);
		expect(
			await objects.apply(
				[
					{ ref: 'refs/heads/main', old: one.commit.oid, next: a.commit.oid },
					{
						ref: 'refs/epicenter/replaced/x',
						old: ZERO_OID,
						next: a.commit.oid,
					},
				],
				a.pack,
			),
		).toEqual({ ok: true });
		const lost = await objects.apply(
			[
				{ ref: 'refs/heads/main', old: one.commit.oid, next: b.commit.oid },
				{ ref: 'refs/epicenter/replaced/y', old: ZERO_OID, next: b.commit.oid },
			],
			b.pack,
		);
		expect(lost).toMatchObject({ ok: false, stale: true });
		const refs = await objects.refs();
		expect(refs.get('refs/heads/main')).toBe(a.commit.oid);
		expect(refs.has('refs/epicenter/replaced/y')).toBe(false);
		// A second ref of the same name is refused as stale, too.
		const again = await objects.apply(
			[{ ref: 'refs/epicenter/replaced/x', old: ZERO_OID, next: a.commit.oid }],
			null,
		);
		expect(again).toMatchObject({ ok: false, stale: true });
		objects.close();
	});

	test('a commit whose objects are missing is refused before any ref moves', async () => {
		const { objects } = await fresh();
		const one = commitOf({ 'a.md': 'one\n' });
		const partial = writePack(one.objects.filter((o) => o.kind !== 'blob'));
		const refused = await objects.apply(
			[{ ref: 'refs/heads/main', old: ZERO_OID, next: one.commit.oid }],
			partial,
		);
		expect(refused).toMatchObject({ ok: false, stale: false });
		expect((await objects.refs()).size).toBe(0);
		objects.close();
	});

	test('upload-pack lists every ref, in protocol v0 and in v2', async () => {
		const { id, objects } = await fresh();
		const one = commitOf({ 'a.md': 'one\n' });
		await objects.apply(
			[
				{ ref: 'refs/heads/main', old: ZERO_OID, next: one.commit.oid },
				{
					ref: 'refs/epicenter/replaced/20261030-000000000Z',
					old: ZERO_OID,
					next: one.commit.oid,
				},
			],
			one.pack,
		);
		objects.close();
		const serve = (
			headers: Record<string, string>,
			body: Uint8Array | null,
		) =>
			host.serve(id, {
				service: 'git-upload-pack',
				advertisement: body === null,
				headers: new Headers(headers),
				body: body && new Blob([body as BlobPart]).stream(),
				signal: new AbortController().signal,
				accountId: 'test',
			});
		const v0 = await (await serve({}, null)).text();
		expect(v0).toContain(`${one.commit.oid} refs/heads/main`);
		expect(v0).toContain('refs/epicenter/replaced/');

		const v2 = { 'git-protocol': 'version=2' };
		expect(await (await serve(v2, null)).text()).toContain('version 2');
		const pkt = (line: string) =>
			`${(line.length + 4).toString(16).padStart(4, '0')}${line}`;
		const lsRefs = new TextEncoder().encode(
			`${pkt('command=ls-refs\n')}0001${pkt('peel\n')}0000`,
		);
		const listed = await (
			await serve(
				{
					...v2,
					'content-type': 'application/x-git-upload-pack-request',
				},
				lsRefs,
			)
		).text();
		expect(listed).toContain(`${one.commit.oid} refs/heads/main`);
		expect(listed).toContain('refs/epicenter/replaced/');
		expect(repositoryPath(join(box.root, 'store'), id)).toContain(id);
	});
});
