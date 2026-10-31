/**
 * The Artifacts `GitObjects` against a scripted repository handle and a
 * stubbed `fetch`, which stand in for the binding and Artifacts' Git
 * endpoint (neither has a local emulation). The deployed spike exercises
 * the real ones (spike-scratch/deployed-spike-8).
 */
import { afterEach, describe, expect, test } from 'bun:test';
import { randomBytes } from 'node:crypto';
import { resolveOAuthAudiences } from '@epicenter/constants/apps';
import {
	type CloudEnv,
	FLUSH,
	type GitAccess,
	makeObject,
	mountGitHost,
	parseCommit,
	pktLine,
	type ReceiveLimits,
	readCommandLines,
	treeObject,
	writePack,
	ZERO_OID,
} from '@epicenter/server';
import { Hono } from 'hono';
import { createMiddleware } from 'hono/factory';
import {
	type ArtifactsCommit,
	type ArtifactsReader,
	type ArtifactsTreeEntry,
	createArtifactsObjects,
} from './artifacts-objects.js';

const realFetch = globalThis.fetch;
afterEach(() => {
	globalThis.fetch = realFetch;
});

const REMOTE = 'https://acct.artifacts.cloudflare.net/git/ns/repo1.git';
const A = 'a'.repeat(40);
const B = 'b'.repeat(40);
const C = 'c'.repeat(40);

type Packed = ReturnType<typeof makeObject>;

const pkts = (...parts: (string | null)[]) =>
	new Blob(parts.map((p) => (p === null ? FLUSH : pktLine(p))) as BlobPart[]);

function commit(
	hash: string,
	parents: string[],
	message = 'm',
): ArtifactsCommit {
	return {
		hash,
		treeHash: 'f'.repeat(40),
		parents,
		message,
		author: { name: 'Ada', email: 'ada@example.invalid' },
		committer: { name: 'Ada', email: 'ada@example.invalid' },
		authoredAt: 1793371154,
		committedAt: 1793371155,
	};
}

function handle({
	commits = new Map<string, ArtifactsCommit>(),
	trees = new Map<string, ArtifactsTreeEntry[]>(),
	blobs = new Map<string, Uint8Array>(),
} = {}) {
	const reads: string[] = [];
	const reader: ArtifactsReader = {
		async readCommit(oid) {
			reads.push(`commit ${oid}`);
			const found = commits.get(oid);
			if (!found)
				throw Object.assign(new Error('object not found'), {
					code: 'NOT_FOUND',
				});
			return found;
		},
		async readTree(oid) {
			reads.push(`tree ${oid}`);
			return trees.get(oid) ?? null;
		},
		async readBlob(oid) {
			reads.push(`blob ${oid}`);
			const bytes = blobs.get(oid);
			return bytes
				? { size: bytes.length, arrayBuffer: async () => bytes.slice().buffer }
				: null;
		},
	};
	return { reader, reads };
}

function objectsOver(reader: ArtifactsReader, refused: string[] = []) {
	return createArtifactsObjects({
		remote: REMOTE,
		token: () => ({
			value: Promise.resolve('art_token'),
			refused: () => refused.push('refused'),
		}),
		repository: async () => reader,
	});
}

/** A commit as a client packs it. */
const commitObject = (tree: string, parents: string[]) =>
	makeObject(
		'commit',
		`tree ${tree}\n${parents.map((p) => `parent ${p}\n`).join('')}author Ada <ada@example.invalid> 1793371154 +0000\ncommitter Ada <ada@example.invalid> 1793371154 +0000\n\nm\n`,
	);

/**
 * `mountGitHost` with the receiver over `reader`, Artifacts' Git endpoint
 * stubbed with `main` at `main`. `push` sends a pack over `main` and answers
 * the report; `applied` collects the commands that reached Artifacts.
 */
function receiverOver(
	reader: ArtifactsReader,
	main: string,
	receiveLimits?: ReceiveLimits,
) {
	const applied: string[] = [];
	globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
		if (String(input).endsWith('/info/refs?service=git-receive-pack'))
			return new Response(
				pkts(
					'# service=git-receive-pack\n',
					null,
					`${main} refs/heads/main\0report-status atomic ofs-delta\n`,
					null,
				),
			);
		const { lines } = readCommandLines(
			new Uint8Array(await new Response(init?.body).arrayBuffer()),
		);
		applied.push(...lines);
		return new Response(pkts('unpack ok\n', 'ok refs/heads/main\n', null));
	}) as unknown as typeof fetch;

	const access: GitAccess = {
		async authorize(_c, { namespaceId }) {
			return {
				data: {
					accountId: 'owner',
					role: 'owner',
					namespaceId,
					repository: { id: 'repo1' },
				},
				error: null,
			};
		},
		async create() {
			return { id: 'repo1' };
		},
	};
	const app = new Hono<CloudEnv>();
	app.use('*', async (c, next) => {
		c.set('audiences', resolveOAuthAudiences(new URL(c.req.url).origin));
		await next();
	});
	mountGitHost(app, {
		setup: createMiddleware<CloudEnv>(async (_c, next) => next()),
		access,
		resolveHost: () => ({
			serve: async () => new Response(null, { status: 500 }),
			create: async () => {},
			delete: async () => {},
			objects: () => objectsOver(reader),
			receiveLimits,
		}),
	});
	const push = async (next: Packed, ...more: Packed[]) => {
		const body = new Blob([
			pktLine(`${main} ${next.oid} refs/heads/main\0report-status\n`),
			FLUSH,
			writePack([next, ...more]),
		] as BlobPart[]);
		const response = await app.request(
			'http://localhost:8787/git/~/notes.git/git-receive-pack',
			{
				method: 'POST',
				headers: {
					'content-type': 'application/x-git-receive-pack-request',
				},
				body,
			},
		);
		return `${response.status} ${await response.text()}`;
	};
	return { push, applied };
}

describe('Artifacts GitObjects', () => {
	test('refs come from the receive-pack advertisement, every ref included', async () => {
		const requests: [string, string | null][] = [];
		globalThis.fetch = (async (
			input: RequestInfo | URL,
			init?: RequestInit,
		) => {
			requests.push([
				String(input),
				new Headers(init?.headers).get('authorization'),
			]);
			return new Response(
				pkts(
					'# service=git-receive-pack\n',
					null,
					`${A} refs/heads/main\0report-status atomic ofs-delta\n`,
					`${B} refs/epicenter/replaced/20261031-000000000Z\n`,
					null,
				),
			);
		}) as unknown as typeof fetch;
		const refs = await objectsOver(handle().reader).refs();
		expect([...refs]).toEqual([
			['refs/heads/main', A],
			['refs/epicenter/replaced/20261031-000000000Z', B],
		]);
		expect(requests).toEqual([
			[
				`${REMOTE}/info/refs?service=git-receive-pack`,
				`Basic ${btoa('x:art_token')}`,
			],
		]);
	});

	test('a tree is rebuilt byte for byte, so it hashes to its id', async () => {
		const blob = makeObject('blob', 'hello\n');
		const sub = treeObject([{ mode: '100644', name: 'a.md', oid: blob.oid }]);
		const root = treeObject([
			{ mode: '40000', name: 'notes', oid: sub.oid },
			{ mode: '100644', name: 'notes.md', oid: blob.oid },
			{ mode: '100755', name: 'run', oid: blob.oid },
		]);
		const { reader } = handle({
			trees: new Map([
				[
					root.oid,
					[
						// Artifacts' order and mode spellings, numeric included.
						{ name: 'run', mode: '100755', hash: blob.oid },
						{ name: 'notes.md', mode: 0o100644, hash: blob.oid },
						{ name: 'notes', mode: '040000', hash: sub.oid, type: 'tree' },
					],
				],
			]),
		});
		const read = await objectsOver(reader).read(root.oid, 'tree');
		expect(read?.bytes).toEqual(root.bytes);
		expect(makeObject('tree', read?.bytes as Uint8Array).oid).toBe(root.oid);
	});

	test('a commit is rebuilt from its fields, enough to parse', async () => {
		const message = 'Web write: 1 file\n\nA body line.';
		const { reader } = handle({
			commits: new Map([[A, commit(A, [B, C], message)]]),
		});
		const objects = objectsOver(reader);
		const read = await objects.read(A, 'commit');
		expect(parseCommit(read?.bytes as Uint8Array)).toEqual({
			tree: 'f'.repeat(40),
			parents: [B, C],
			message,
		});
		expect(await objects.read(B, 'commit')).toBeNull();
	});

	test('a blob over maxBytes comes back with its size only', async () => {
		const bytes = new TextEncoder().encode('x'.repeat(600));
		const { reader } = handle({ blobs: new Map([[A, bytes]]) });
		const objects = objectsOver(reader);
		expect(await objects.read(A, 'blob', { maxBytes: 512 })).toEqual({
			size: 600,
			bytes: null,
		});
		expect((await objects.read(A, 'blob'))?.bytes).toEqual(bytes);
		expect(await objects.read(B, 'blob')).toBeNull();
	});

	test('apply sends one atomic receive-pack and reads its report', async () => {
		let sent = new Uint8Array();
		let reply = pkts(
			'unpack ok\n',
			`ok refs/heads/main\n`,
			'ok refs/epicenter/replaced/c\n',
			null,
		);
		globalThis.fetch = (async (
			_input: RequestInfo | URL,
			init?: RequestInit,
		) => {
			sent = new Uint8Array(await new Response(init?.body).arrayBuffer());
			return new Response(reply);
		}) as unknown as typeof fetch;
		const objects = objectsOver(handle().reader);
		const updates = [
			{ ref: 'refs/heads/main', old: A, next: B },
			{ ref: 'refs/epicenter/replaced/c', old: ZERO_OID, next: B },
		];
		expect(await objects.apply(updates, null)).toEqual({ ok: true });
		const { lines, rest } = readCommandLines(sent);
		expect(lines).toEqual([
			`${A} ${B} refs/heads/main\0report-status atomic agent=epicenter\n`,
			`${ZERO_OID} ${B} refs/epicenter/replaced/c\n`,
		]);
		// No pack given: an empty one, which receive-pack needs for a non-delete.
		expect(new TextDecoder().decode(rest.subarray(0, 4))).toBe('PACK');

		reply = pkts(
			'unpack ok\n',
			'ng refs/heads/main stale ref\n',
			'ng refs/epicenter/replaced/c stale ref\n',
			null,
		);
		expect(await objects.apply(updates, null)).toEqual({
			ok: false,
			stale: true,
			reason:
				'ng refs/heads/main stale ref; ng refs/epicenter/replaced/c stale ref',
		});
		reply = pkts('unpack index-pack failed\n', null);
		expect(await objects.apply(updates, null)).toMatchObject({
			ok: false,
			stale: false,
		});
	});

	test('a refused token is dropped, and the request fails', async () => {
		globalThis.fetch = (async () =>
			new Response('no', { status: 401 })) as unknown as typeof fetch;
		const refused: string[] = [];
		await expect(objectsOver(handle().reader, refused).refs()).rejects.toThrow(
			'Artifacts answered 401',
		);
		expect(refused).toEqual(['refused']);
	});

	test("the receiver's walk reads Artifacts by kind: a stored side commit is checked when a push reaches it", async () => {
		// Stored: main M (a.md), and side commit S (M plus raw audio) that an
		// earlier push left in the store without moving main.
		const note = makeObject('blob', 'x\n');
		const audio = makeObject('blob', new Uint8Array([0, 0, 0, 0x20, 0x66]));
		const t0 = treeObject([{ mode: '100644', name: 'a.md', oid: note.oid }]);
		const t1 = treeObject([
			{ mode: '100644', name: 'a.md', oid: note.oid },
			{ mode: '100644', name: 'a.m4a', oid: audio.oid },
		]);
		const entries = (...files: [string, string][]): ArtifactsTreeEntry[] =>
			files.map(([name, hash]) => ({ name, mode: '100644', hash }));
		const stored = (hash: string, tree: string, parents: string[]) =>
			[hash, { ...commit(hash, parents), treeHash: tree }] as const;
		const M = 'd'.repeat(40);
		const S = 'e'.repeat(40);
		const { reader, reads } = handle({
			commits: new Map([stored(M, t0.oid, []), stored(S, t1.oid, [M])]),
			trees: new Map([
				[t0.oid, entries(['a.md', note.oid])],
				[t1.oid, entries(['a.md', note.oid], ['a.m4a', audio.oid])],
			]),
			blobs: new Map([
				[note.oid, note.bytes],
				[audio.oid, audio.bytes],
			]),
		});
		const { push, applied } = receiverOver(reader, M);
		// X merges S into main but keeps main's tree, so X itself changes
		// nothing; only S, read from Artifacts by kind, holds the raw audio.
		const refused = await push(commitObject(t0.oid, [M, S]));
		expect(refused).toContain('a.m4a in eeeeeeee');
		expect(refused).toContain('is not a Git LFS pointer');
		expect(reads).toContain(`commit ${S}`);
		expect(reads).toContain(`tree ${t1.oid}`);
		expect(reads).toContain(`blob ${audio.oid}`);
		expect(applied).toEqual([]);

		// A plain fast-forward: its parent is main, so the walk stops there.
		const t2 = treeObject([
			{ mode: '100644', name: 'a.md', oid: note.oid },
			{ mode: '100644', name: 'b.md', oid: note.oid },
		]);
		const y = commitObject(t2.oid, [M]);
		reads.length = 0;
		expect(await push(y, t2)).toContain('ok refs/heads/main');
		expect(reads).not.toContain(`commit ${S}`);
		expect(applied[0]).toStartWith(`${M} ${y.oid} refs/heads/main`);
	});
	test("a desktop offline for 600 captures pushes in one read of main's history, checking only its own changes", async () => {
		// Main: 650 commits. Commit 3 added raw audio, which the receiver
		// would refuse, so checking more than the push's own changes fails;
		// every later commit keeps that tree.
		const note = makeObject('blob', 'x\n');
		const audio = makeObject('blob', new Uint8Array([0, 0, 0, 0x20, 0x66]));
		const t0 = treeObject([{ mode: '100644', name: 'a.md', oid: note.oid }]);
		const t1 = treeObject([
			{ mode: '100644', name: 'a.md', oid: note.oid },
			{ mode: '100644', name: 'a.m4a', oid: audio.oid },
		]);
		const id = (n: number) => n.toString(16).padStart(40, '0');
		const commits = new Map<string, ArtifactsCommit>();
		for (let n = 1; n <= 650; n++)
			commits.set(id(n), {
				...commit(id(n), n === 1 ? [] : [id(n - 1)]),
				treeHash: n < 3 ? t0.oid : t1.oid,
			});
		const entries = (...files: [string, string][]): ArtifactsTreeEntry[] =>
			files.map(([name, hash]) => ({ name, mode: '100644', hash }));
		const { reader, reads } = handle({
			commits,
			trees: new Map([
				[t0.oid, entries(['a.md', note.oid])],
				[t1.oid, entries(['a.md', note.oid], ['a.m4a', audio.oid])],
			]),
			blobs: new Map([
				[note.oid, note.bytes],
				[audio.oid, audio.bytes],
			]),
		});
		const { push, applied } = receiverOver(reader, id(650));

		// The desktop last synced at commit 20, wrote a note, and merged main.
		const desk = makeObject('blob', 'offline\n');
		const t2 = treeObject([
			{ mode: '100644', name: 'a.md', oid: note.oid },
			{ mode: '100644', name: 'a.m4a', oid: audio.oid },
			{ mode: '100644', name: 'desk.md', oid: desk.oid },
		]);
		const written = commitObject(t2.oid, [id(20)]);
		const merge = commitObject(t2.oid, [written.oid, id(650)]);
		expect(await push(merge, written, t2, desk)).toContain(
			'ok refs/heads/main',
		);
		expect(applied[0]).toStartWith(`${id(650)} ${merge.oid} refs/heads/main`);
		const commitReads = reads.filter((read) => read.startsWith('commit '));
		// Main's history from its tip down to commit 20, once, and no more.
		expect(commitReads.length).toBeGreaterThan(600);
		expect(commitReads.length).toBeLessThan(700);
		expect(reads).not.toContain(`blob ${audio.oid}`);
	});
	test("a push past the Worker's allowance is refused with a reason, before or while it is read", async () => {
		const { reader } = handle();
		const MiB = 1024 * 1024;
		const limits = (pushBytes: number, heldBytes: number): ReceiveLimits => ({
			pushBytes,
			heldBytes,
			mainCommits: 5_000,
		});
		const noise = (bytes: number) => makeObject('blob', randomBytes(bytes));
		const tree = (blob: Packed) =>
			treeObject([{ mode: '100644', name: 'a.md', oid: blob.oid }]);

		// A body over `pushBytes` is not read.
		const big = noise(2 * MiB);
		const tooLong = receiverOver(reader, A, limits(1 * MiB, 24 * MiB));
		const refused = await tooLong.push(
			commitObject(tree(big).oid, [A]),
			tree(big),
			big,
		);
		expect(refused).toStartWith('413 ');
		expect(refused).toContain('A push may be at most 1 MiB');
		expect(tooLong.applied).toEqual([]);

		// A pack that needs more than `heldBytes` at once is refused as it is read.
		const wide = noise(1.5 * MiB);
		const tooWide = receiverOver(reader, A, limits(8 * MiB, 1 * MiB));
		const held = await tooWide.push(
			commitObject(tree(wide).oid, [A]),
			tree(wide),
			wide,
		);
		expect(held).toContain('refused (pack: its objects need more than 1 MiB');
		expect(tooWide.applied).toEqual([]);
	});
});
