/**
 * Browser Git's transfers cost what changed, not what the history holds:
 * the fetch in `browser-backend.ts`, the push in `push.ts`. A remote of many files and commits, served by the system
 * `git http-backend`, is fetched once; every later fetch and push of one
 * changed file is counted by the objects in the pack each side sent.
 *
 * Key behaviors:
 * - A fetch tells the server the remote-tracking commit, so a folder with a
 *   commit the remote lacks receives only the remote's new objects. This
 *   relies on isomorphic-git sending `ref` as its one have, so an upgrade
 *   that changes it fails here
 * - A push of a merge whose other parent is behind the remote head sends
 *   its new commits and the trees and blobs they changed, not the history
 */
import { expect, test } from 'bun:test';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import * as git from 'isomorphic-git';
import { rawBrowserFolder } from '../browser-storage.test-support.js';
import {
	createBareRemote,
	gitHttpFetch,
	git as nativeGit,
	scratch,
} from '../git-http.test-support.js';
import type { HttpFetch } from './http.js';

const FILES = 1000;
const COMMITS = 30;

/** The object count of the pack in `bytes`, or 0 when there is none. */
function packObjects(bytes: Uint8Array): number {
	const at = Buffer.from(bytes).indexOf('PACK');
	if (at < 0) return 0;
	return new DataView(bytes.buffer, bytes.byteOffset + at + 8, 4).getUint32(0);
}

const haves = (bytes: Uint8Array) =>
	[...new TextDecoder().decode(bytes).matchAll(/have ([0-9a-f]{40})/g)].map(
		(match) => match[1],
	);

test('a fetch and a push of one changed file transfer that change, not the history', async () => {
	const root = await scratch('folder-transfer-');
	const bare = await createBareRemote(root);
	const native = join(root, 'native');
	await nativeGit(root, 'init', '--quiet', '--initial-branch=main', native);
	await mkdir(join(native, 'rows'));
	for (let index = 0; index < FILES; index++)
		await writeFile(join(native, `rows/${index}.md`), `row ${index}\n`);
	await nativeGit(native, 'add', '.');
	await nativeGit(native, 'commit', '--quiet', '-m', 'Rows');
	for (let commit = 1; commit < COMMITS; commit++) {
		await writeFile(join(native, `rows/${commit}.md`), `row ${commit} v2\n`);
		await nativeGit(native, 'commit', '--quiet', '-am', `Edit ${commit}`);
	}
	await nativeGit(native, 'push', '--quiet', bare, 'main');
	const remoteEdit = async (row: number) => {
		await writeFile(join(native, `rows/${row}.md`), `remote edit ${row}\n`);
		await nativeGit(native, 'commit', '--quiet', '-am', `Remote ${row}`);
		await nativeGit(native, 'push', '--quiet', bare, 'main');
	};

	// The request and reply of the last transfer's pack exchange.
	const serve = await gitHttpFetch(root);
	let sent = new Uint8Array();
	let received = new Uint8Array();
	const httpFetch: HttpFetch = async (input, init) => {
		const request = new Request(input, init);
		const body = new Uint8Array(await request.clone().arrayBuffer());
		const response = await serve(request);
		const reply = new Uint8Array(await response.arrayBuffer());
		if (request.method === 'POST') [sent, received] = [body, reply];
		return new Response(reply, {
			status: response.status,
			headers: response.headers,
		});
	};
	const raw = await rawBrowserFolder({ id: 'transfer' });
	const backend = await raw.backend({
		remote: { url: 'http://git.test/remote.git', branch: 'main' },
		httpFetch,
	});
	const signal = new AbortController().signal;

	/** A commit with `parents` whose tree is `base`'s with one row changed. */
	const commitRow = (base: string, row: number, parents = [base]) =>
		backend.withObjects(async (access) => {
			const { commit } = await git.readCommit({ ...access, oid: base });
			const top = (await git.readTree({ ...access, oid: commit.tree })).tree;
			const rowsOid = top.find((entry) => entry.path === 'rows')?.oid ?? '';
			const rows = (await git.readTree({ ...access, oid: rowsOid })).tree;
			const blob = await git.writeBlob({
				...access,
				blob: new TextEncoder().encode(`local edit ${row}\n`),
			});
			const rowsTree = await git.writeTree({
				...access,
				tree: rows.map((entry) =>
					entry.path === `${row}.md` ? { ...entry, oid: blob } : entry,
				),
			});
			const tree = await git.writeTree({
				...access,
				tree: top.map((entry) =>
					entry.path === 'rows' ? { ...entry, oid: rowsTree } : entry,
				),
			});
			const author = {
				name: 'Test',
				email: 'test@example.test',
				timestamp: Math.floor(Date.now() / 1000),
				timezoneOffset: 0,
			};
			return git.writeCommit({
				...access,
				commit: {
					tree,
					parent: parents,
					author,
					committer: author,
					message: `Local ${row}\n`,
				},
			});
		});

	try {
		const first = await backend.fetch(signal);
		expect(packObjects(received)).toBeGreaterThan(FILES);
		expect(await backend.casBranch(undefined, first ?? '')).toEqual({
			ok: true,
		});

		// A commit, its two trees, and the one blob.
		await remoteEdit(FILES - 1);
		const second = (await backend.fetch(signal)) ?? '';
		expect(packObjects(received)).toBe(4);
		expect(await backend.casBranch(first, second)).toEqual({ ok: true });

		// The folder holds a commit the remote lacks when the remote moves.
		const mine = await commitRow(second, 7);
		expect(await backend.casBranch(second, mine)).toEqual({ ok: true });
		await nativeGit(native, 'pull', '--quiet', bare, 'main');
		await remoteEdit(FILES - 2);
		const third = (await backend.fetch(signal)) ?? '';
		expect(haves(sent)).toEqual([second]);
		expect(packObjects(received)).toBe(4);
		expect(await backend.readRemoteTracking()).toBe(third);

		// The merge and its two trees; the folder's commit, its two trees,
		// and its blob, which the merge keeps at the same path.
		const merge = await commitRow(third, 7, [mine, third]);
		expect(await backend.push(merge, signal)).toBe('pushed');
		expect(packObjects(sent)).toBe(7);
		expect(await nativeGit(bare, 'rev-parse', 'main')).toBe(merge);
		expect(await backend.readRemoteTracking()).toBe(merge);

		const next = await commitRow(merge, 8);
		expect(await backend.push(next, signal)).toBe('pushed');
		expect(packObjects(sent)).toBe(4);
		await nativeGit(bare, 'fsck', '--strict');
		expect(await nativeGit(bare, 'show', 'main:rows/7.md')).toBe(
			'local edit 7',
		);
	} finally {
		await rm(root, { recursive: true, force: true });
	}
}, 60_000);
