/**
 * The receiver against the disk store, with pushes built by stock Git
 * (`git pack-objects`) from a working copy, as `git push` would send them.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import { rm, symlink } from 'node:fs/promises';
import { join } from 'node:path';
import { type GitObjects, MAIN, ZERO_OID } from '../git/objects.js';
import { FLUSH, pktLine } from '../git/pkt.js';
import { createDiskGitHost, repositoryPath } from '../git-disk-store.js';
import { createDiskLfsStore } from '../lfs/disk-lfs-store.js';
import type { LfsStore } from '../lfs/lfs-store.js';
import { newRepositoryId } from '../repositories.js';
import {
	createGitSandbox,
	type GitSandbox,
} from '../test-helpers/sandbox-git.js';
import {
	RECEIVE_LIMITS,
	type ReceiveLimits,
	receiveAdvertisement,
	receivePush,
	replacedRef,
} from './receive.js';

let box: GitSandbox;
let host: ReturnType<typeof createDiskGitHost>;
let lfs: LfsStore;
beforeAll(async () => {
	box = await createGitSandbox();
	host = createDiskGitHost({ root: join(box.root, 'store') });
	lfs = createDiskLfsStore({ root: join(box.root, 'lfs') });
});
afterAll(async () => {
	await rm(box.root, { recursive: true, force: true });
});

async function setup() {
	const id = newRepositoryId();
	await host.create(id);
	const objects = host.objects?.(id) as GitObjects;
	const work = await box.dir('work');
	await box.ok(work, ['init', '--quiet']);
	const commit = async (
		files: Record<string, string | Uint8Array>,
		message = 'c',
	) => {
		await box.write(work, files);
		await box.ok(work, ['add', '-A']);
		await box.ok(work, ['commit', '--quiet', '--allow-empty', '-m', message]);
		return (await box.ok(work, ['rev-parse', 'HEAD'])).trim();
	};
	const main = async () => (await objects.refs()).get(MAIN) ?? ZERO_OID;
	/**
	 * Push `next` over the server's `old` (default: main now), as `git push`
	 * would. `revs` adds lines to the pack's rev list, as a crafted client
	 * may: `<oid>` to carry more, `^<oid>` to leave some out.
	 */
	const push = async (
		next: string,
		{
			old,
			owner = false,
			revs: extra = [],
			via = objects,
			limits,
		}: {
			old?: string;
			owner?: boolean;
			revs?: string[];
			/** The objects the receiver reads, when a test counts its reads. */
			via?: GitObjects;
			limits?: ReceiveLimits;
		} = {},
	) => {
		const current = old ?? (await main());
		const revs = [
			next,
			...(current === ZERO_OID ? [] : [`^${current}`]),
			...extra,
		]
			.map((rev) => `${rev}\n`)
			.join('');
		const child = Bun.spawn(
			['git', 'pack-objects', '--stdout', '--revs', '--delta-base-offset'],
			{
				cwd: work,
				env: box.env,
				stdin: new Blob([revs]),
				stdout: 'pipe',
				stderr: 'ignore',
			},
		);
		const pack = new Uint8Array(await new Response(child.stdout).arrayBuffer());
		await child.exited;
		const body = Buffer.concat([
			pktLine(`${current} ${next} ${MAIN}\0report-status ofs-delta\n`),
			FLUSH,
			pack,
		]);
		const response = await receivePush({
			objects: via,
			lfs,
			repositoryId: id,
			body,
			mayRewrite: owner,
			limits,
		});
		return new TextDecoder().decode(await response.arrayBuffer());
	};
	return {
		id,
		objects,
		work,
		commit,
		main,
		push,
		gitDir: repositoryPath(join(box.root, 'store'), id),
	};
}

const pointerFor = (bytes: Uint8Array) => {
	const oid = createHash('sha256').update(bytes).digest('hex');
	return {
		oid,
		size: bytes.length,
		text: `version https://git-lfs.github.com/spec/v1\noid sha256:${oid}\nsize ${bytes.length}\n`,
	};
};

/** `objects`, counting the commits it reads and every `isAncestor` asked of it. */
function counting(objects: GitObjects) {
	const counts = { commitReads: 0, isAncestor: 0 };
	const counted: GitObjects = {
		...objects,
		read(oid, kind, options) {
			if (kind === 'commit') counts.commitReads++;
			return objects.read(oid, kind, options);
		},
		isAncestor(ancestor, descendant) {
			counts.isAncestor++;
			return objects.isAncestor(ancestor, descendant);
		},
	};
	return { counts, objects: counted };
}

/**
 * Store a `length`-commit history on `main` straight into the bare
 * repository, as pushes before the receiver did: commit 3 adds raw audio,
 * and every commit adds a note. Returns main's tip.
 */
async function storeLongHistory(
	r: Awaited<ReturnType<typeof setup>>,
	length: number,
) {
	const parts: string[] = [];
	const data = (text: string) => `data ${Buffer.byteLength(text)}\n${text}\n`;
	for (let n = 1; n <= length; n++) {
		parts.push(
			`commit refs/heads/main\ncommitter Ada <ada@example.invalid> ${1_700_000_000 + n} +0000\n`,
			data(`capture ${n}`),
			`M 100644 inline notes/n${n}.md\n`,
			data(`note ${n}`),
		);
		if (n === 3)
			parts.push('M 100644 inline rec/old.m4a\n', data('raw audio bytes'));
	}
	await box.ok(r.work, ['fast-import', '--quiet'], parts.join(''));
	await box.ok(r.work, ['checkout', '--quiet', '-f', 'main']);
	await box.ok(r.work, ['push', '--quiet', r.gitDir, 'main:main']);
	return (await box.ok(r.work, ['rev-parse', 'main'])).trim();
}

describe('receivePush over a long history', () => {
	test("a desktop offline for 600 captures pushes, reading main's history once, past raw bytes from before the receiver", async () => {
		const r = await setup();
		const tip = await storeLongHistory(r, 650);
		// The desktop last synced 630 captures ago, recorded, then merged main.
		await box.ok(r.work, ['checkout', '--quiet', '-b', 'desk', 'main~630']);
		await r.commit({ 'desk.md': 'written offline\n' });
		await box.ok(r.work, ['merge', '--quiet', '--no-edit', 'main']);
		const merge = (await box.ok(r.work, ['rev-parse', 'HEAD'])).trim();

		const { counts, objects } = counting(r.objects);
		expect(await r.push(merge, { old: tip, via: objects })).toContain(
			`ok ${MAIN}`,
		);
		expect(await r.main()).toBe(merge);
		expect(counts.isAncestor).toBe(0);
		// Main's commits down to the desktop's base, once, and a few more.
		expect(counts.commitReads).toBeGreaterThan(600);
		expect(counts.commitReads).toBeLessThan(700);
	});

	test('a stored commit beyond what the deployment may read of main is refused, and says why', async () => {
		const r = await setup();
		const tip = await storeLongHistory(r, 150);
		await box.ok(r.work, ['checkout', '--quiet', '-b', 'desk', 'main~130']);
		await r.commit({ 'desk.md': 'written offline\n' });
		await box.ok(r.work, ['merge', '--quiet', '--no-edit', 'main']);
		const merge = (await box.ok(r.work, ['rev-parse', 'HEAD'])).trim();
		const refused = await r.push(merge, {
			old: tip,
			limits: { ...RECEIVE_LIMITS, mainCommits: 100 },
		});
		expect(refused).toContain("within main's last 100 commits");
		expect(await r.main()).toBe(tip);
	});
});

describe('receivePush', () => {
	test('a fast-forward lands, and so does a merge commit', async () => {
		const r = await setup();
		const one = await r.commit({ 'a.md': 'one\n' });
		expect(await r.push(one)).toContain(`ok ${MAIN}`);
		const two = await r.commit({ 'b.md': 'two\n' });
		expect(await r.push(two)).toContain(`ok ${MAIN}`);
		// A side branch from one, merged back with --no-ff.
		await box.ok(r.work, ['checkout', '--quiet', '-b', 'side', one]);
		await r.commit({ 'c.md': 'side\n' });
		await box.ok(r.work, ['checkout', '--quiet', 'main']);
		await box.ok(r.work, [
			'merge',
			'--quiet',
			'--no-ff',
			'-m',
			'merge',
			'side',
		]);
		const merge = (await box.ok(r.work, ['rev-parse', 'HEAD'])).trim();
		expect(await r.push(merge)).toContain(`ok ${MAIN}`);
		expect(await r.main()).toBe(merge);
	});

	test('a stale old value is told to fetch first', async () => {
		const r = await setup();
		const one = await r.commit({ 'a.md': 'one\n' });
		await r.push(one);
		const two = await r.commit({ 'a.md': 'two\n' });
		expect(await r.push(two, { old: ZERO_OID })).toContain(
			'stale (main moved; fetch first)',
		);
	});

	test("a member's rewrite is refused; the owner's lands and keeps the old main", async () => {
		const r = await setup();
		const one = await r.commit({ 'a.md': 'one\n' });
		await r.push(one);
		const two = await r.commit({ 'a.md': 'two\n' });
		await r.push(two);
		await box.ok(r.work, ['commit', '--quiet', '--amend', '-m', 'amended']);
		const amended = (await box.ok(r.work, ['rev-parse', 'HEAD'])).trim();
		expect(await r.push(amended)).toContain(
			'non-fast-forward: only the repository owner may rewrite main',
		);
		expect(await r.main()).toBe(two);
		const before = new Date();
		expect(await r.push(amended, { owner: true })).toContain(`ok ${MAIN}`);
		expect(await r.main()).toBe(amended);
		const replaced = [...(await r.objects.refs())].filter(([ref]) =>
			ref.startsWith('refs/epicenter/replaced/'),
		);
		expect(replaced).toHaveLength(1);
		expect(replaced[0]?.[1]).toBe(two);
		expect(
			(replaced[0]?.[0] ?? '') >=
				replacedRef(new Date(before.getTime() - 1000)),
		).toBe(true);
	});

	test('raw bytes at a non-note path are refused, whatever .gitattributes says', async () => {
		const r = await setup();
		const one = await r.commit({
			'.gitattributes': '*.webm filter=lfs diff=lfs merge=lfs -text\n',
			'a.md': 'x\n',
		});
		await r.push(one);
		const raw = await r.commit({
			'rec/raw.webm': new Uint8Array([0x1a, 0x45, 0xdf, 0xa3, 1, 2, 3]),
		});
		expect(await r.push(raw)).toContain('rec/raw.webm in');
		await box.ok(r.work, ['reset', '--quiet', '--hard', one]);
		const unattributed = await r.commit({
			'.gitattributes': '# LFS removed\n',
			'rec/raw.webm': 'raw\n',
		});
		expect(await r.push(unattributed)).toContain('is not a Git LFS pointer');
		expect(await r.main()).toBe(one);
	});

	test('hidden paths are outside the contract: raw bytes there land (decision 58)', async () => {
		const r = await setup();
		const one = await r.commit({ 'a.md': 'x\n' });
		await r.push(one);
		const hidden = await r.commit({
			'.DS_Store': new Uint8Array([0, 0, 0, 1, 66, 117, 100, 49]),
			'recordings/.DS_Store': new Uint8Array([0, 1, 2]),
			'.epicenter/outbox/c1.json': '{"state":"pending"}\n',
			'recordings/.cache/a.webm': new Uint8Array([0x1a, 0x45, 0xdf, 0xa3]),
		});
		expect(await r.push(hidden)).toContain(`ok ${MAIN}`);
	});

	test('a commit the store holds but main does not reach is checked when a push reaches it (the two-push smuggle)', async () => {
		const r = await setup();
		const one = await r.commit({ 'a.md': 'x\n' });
		await r.push(one);
		// Z: an orphan commit holding raw audio, never itself pushed to main.
		await box.ok(r.work, ['checkout', '--quiet', '--orphan', 'smuggle']);
		const z = await r.commit({
			'rec/a.m4a': new Uint8Array([0, 0, 0, 0x20, 0x66, 0x74, 0x79, 0x70]),
		});
		await box.ok(r.work, ['checkout', '--quiet', '-f', 'main']);
		// Push 1: a valid fast-forward whose pack also carries Z.
		const two = await r.commit({ 'b.md': 'y\n' });
		expect(await r.push(two, { revs: [z] })).toContain(`ok ${MAIN}`);
		// Push 2: N merges Z into main with Z's tree, and leaves Z out of the pack.
		const zTree = (await box.ok(r.work, ['rev-parse', `${z}^{tree}`])).trim();
		const n = (
			await box.ok(r.work, [
				'commit-tree',
				zTree,
				'-p',
				z,
				'-p',
				two,
				'-m',
				'n',
			])
		).trim();
		const refused = await r.push(n, { revs: [`^${z}`] });
		expect(refused).toContain('rec/a.m4a in');
		expect(refused).toContain('is not a Git LFS pointer');
		expect(await r.main()).toBe(two);
		// A commit main already reaches is not checked again: history is not walked past main.
		const three = await r.commit({ 'c.md': 'z\n' });
		expect(await r.push(three)).toContain(`ok ${MAIN}`);
	});

	test('a note is .md in any case: a raw .MD note lands, as a Mac clone commits it', async () => {
		const r = await setup();
		const one = await r.commit({
			'notes/Shout.MD': 'raw text\n',
			'notes/mixed.Md': 'raw text\n',
		});
		expect(await r.push(one)).toContain(`ok ${MAIN}`);
	});

	test('a pointer lands only once its object is uploaded', async () => {
		const r = await setup();
		const audio = new TextEncoder().encode('opus bytes');
		const pointer = pointerFor(audio);
		const one = await r.commit({
			'rec/a.webm': pointer.text,
			'rec/a.md': 'a\n',
		});
		expect(await r.push(one)).toContain(
			'is not uploaded; push it with git lfs first',
		);
		await lfs.put(r.id, pointer.oid, new Blob([audio]).stream());
		expect(await r.push(one)).toContain(`ok ${MAIN}`);
	});

	test('a raw file already on main, renamed by a push, is refused at its new path', async () => {
		const r = await setup();
		const one = await r.commit({
			'notes/raw.md': 'plain text, not a pointer\n',
		});
		await r.push(one);
		await box.ok(r.work, ['mv', 'notes/raw.md', 'notes/raw.bin']);
		await box.ok(r.work, ['commit', '--quiet', '-m', 'rename']);
		const renamed = (await box.ok(r.work, ['rev-parse', 'HEAD'])).trim();
		expect(await r.push(renamed)).toContain('notes/raw.bin in');
	});

	test('only main may be pushed, never deleted, and symlinks are refused', async () => {
		const r = await setup();
		const one = await r.commit({ 'a.md': 'x\n' });
		await r.push(one);
		const other = await receivePush({
			objects: r.objects,
			lfs,
			repositoryId: r.id,
			body: Buffer.concat([
				pktLine(`${ZERO_OID} ${one} refs/heads/other\0report-status\n`),
				FLUSH,
			]),
			mayRewrite: true,
		});
		expect(await other.text()).toContain('only refs/heads/main may be pushed');
		const deleted = await receivePush({
			objects: r.objects,
			lfs,
			repositoryId: r.id,
			body: Buffer.concat([
				pktLine(`${one} ${ZERO_OID} ${MAIN}\0report-status\n`),
				FLUSH,
			]),
			mayRewrite: true,
		});
		expect(await deleted.text()).toContain('deleting main is not allowed');
		await symlink('a.md', join(r.work, 'link.md'));
		const linked = await r.commit({});
		expect(await r.push(linked)).toContain('symbolic link');
	});

	test('a client that asks for side-band-64k gets its report on channel 1', async () => {
		const r = await setup();
		const one = await r.commit({ 'a.md': 'x\n' });
		await r.push(one);
		const response = await receivePush({
			objects: r.objects,
			lfs,
			repositoryId: r.id,
			body: Buffer.concat([
				pktLine(`${one} ${ZERO_OID} ${MAIN}\0report-status side-band-64k\n`),
				FLUSH,
			]),
			mayRewrite: false,
		});
		const bytes = Buffer.from(await response.arrayBuffer());
		expect(bytes[4]).toBe(1);
		expect(bytes.toString('latin1')).toContain(
			'ng refs/heads/main deleting main is not allowed',
		);
		expect(bytes.toString('latin1').endsWith('0000')).toBe(true);
	});

	test("git's probe (a lone flush) gets an empty result", async () => {
		const r = await setup();
		const probe = await receivePush({
			objects: r.objects,
			lfs,
			repositoryId: r.id,
			body: FLUSH,
			mayRewrite: false,
		});
		expect(probe.status).toBe(200);
		expect(await probe.text()).toBe('');
	});
});

describe('receiveAdvertisement', () => {
	test('advertises main alone, with no-thin and ofs-delta', async () => {
		const r = await setup();
		const one = await r.commit({ 'a.md': 'x\n' });
		await r.push(one);
		await r.objects.apply(
			[{ ref: 'refs/epicenter/captures/x', old: ZERO_OID, next: one }],
			null,
		);
		const text = await (await receiveAdvertisement(r.objects)).text();
		expect(text).toContain(
			`${one} refs/heads/main\0report-status side-band-64k ofs-delta no-thin`,
		);
		expect(text).not.toContain('captures');
	});
});
