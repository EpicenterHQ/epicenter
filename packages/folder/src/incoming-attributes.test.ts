/**
 * Incoming Attribute Tests
 *
 * Sync writes each incoming blob's bytes as they are stored. A commit whose
 * attribute files name a Git filter means something else by those bytes
 * (under `filter=lfs` a blob is a pointer), so Sync refuses it before a file,
 * the index, or the branch changes (ADR-0592). Line-ending attributes change
 * nothing Sync writes, so a commit declaring them syncs. These run against a
 * directory's history, as the `epicenter` CLI runs it.
 *
 * Key behaviors:
 * - An LFS filter at the root or in a nested attribute file is refused,
 *   naming the attribute file, with the audio in the folder still the audio
 * - A commit that declares `text` and `eol` syncs, and each file keeps the
 *   bytes the commit stores
 * - Attributes of the files currently in the folder do not mask the incoming
 *   commit's
 * - Nothing is published on refusal: working bytes, index, and HEAD are equal
 *   before and after
 * - Pointer-shaped text with no declared filter is ordinary bytes and
 *   fast-forwards exactly. This is refusal of filters, not LFS support
 *
 * See also:
 * - `git/attributes.test.ts` for which attribute lines name a filter
 */
import {
	afterAll,
	afterEach,
	beforeAll,
	describe,
	expect,
	test,
} from 'bun:test';
import { createHash } from 'node:crypto';
import { mkdir, readdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { expectErr, expectOk } from 'wellcrafted/testing';
import { defineFolder } from './bun.js';
import { formatDefinition } from './declaration.js';
import {
	type DirectoryHistory,
	openDirectoryHistory,
} from './directory-history.test-support.js';
import {
	createBareRemote,
	GIT_ENV,
	git,
	initWithOrigin,
	scratch,
} from './git-http.test-support.js';

const definition = defineFolder({
	tables: {},
});
const author = { name: 'Reader', email: 'reader@example.test' };
const decoder = new TextDecoder();

/** A valid Git LFS pointer. No LFS program is involved in writing it here. */
const LFS_POINTER =
	'version https://git-lfs.github.com/spec/v1\noid sha256:4d7a214614ab2935c943f9e0ff69d22eadbb8f32b1258daaa5e2ca24d17e2393\nsize 12345\n';

const originalEnv = { ...process.env };
beforeAll(() => {
	Object.assign(process.env, {
		GIT_CONFIG_GLOBAL: GIT_ENV.GIT_CONFIG_GLOBAL,
		GIT_CONFIG_NOSYSTEM: '1',
	});
});
afterAll(() => {
	for (const key of ['GIT_CONFIG_GLOBAL', 'GIT_CONFIG_NOSYSTEM'])
		if (originalEnv[key] === undefined) delete process.env[key];
		else process.env[key] = originalEnv[key];
});

const opened: DirectoryHistory[] = [];
afterEach(async () => {
	for (const folder of opened.splice(0)) await folder.close();
});

/** Every file below `root` outside fetched objects and remote refs, hashed. */
async function dumpDirectory(root: string) {
	const dump: Record<string, string> = {};
	async function walk(directory: string, prefix: string) {
		for (const entry of await readdir(directory, { withFileTypes: true })) {
			const path = prefix === '' ? entry.name : `${prefix}/${entry.name}`;
			if (entry.isDirectory()) await walk(join(directory, entry.name), path);
			else if (
				!path.startsWith('.git/objects') &&
				!path.startsWith('.git/refs/remotes') &&
				!path.startsWith('.git/logs/refs/remotes') &&
				path !== '.git/FETCH_HEAD'
			)
				dump[path] = createHash('sha256')
					.update(await readFile(join(directory, entry.name)))
					.digest('hex');
		}
	}
	await walk(root, '');
	return dump;
}

/**
 * A folder that fast-forwarded to an upstream commit holding real audio, and
 * the plain Git clone that upstream commits are made in.
 */
async function incoming() {
	const root = await scratch('incoming-');
	const bare = await createBareRemote(root);
	// Another program's clone: plain Git, so it can commit what a folder
	// itself would refuse to.
	const upstream = join(root, 'upstream');
	await git(root, 'init', '--quiet', '--initial-branch=main', upstream);
	await git(upstream, 'remote', 'add', 'origin', bare);
	await mkdir(join(upstream, 'rec/nested'), { recursive: true });
	await writeFile(join(upstream, 'rec/take.wav'), 'RIFF real audio bytes');
	await writeFile(join(upstream, 'rec/nested/deep.wav'), 'RIFF deeper audio');
	await writeFile(join(upstream, 'notes.md'), 'line one\nline two\n');
	// Lets the folder keep a local, ignored attribute file of its own.
	await writeFile(join(upstream, '.gitignore'), '.gitattributes\n');
	// The root `epicenter.json` a data folder commits for the CLI's readers.
	await writeFile(
		join(upstream, 'epicenter.json'),
		formatDefinition(definition),
	);
	await git(upstream, 'add', '--all');
	await git(upstream, 'commit', '--quiet', '-m', 'audio');
	await git(upstream, 'push', '--quiet', 'origin', 'main');

	const local = join(root, 'local');
	await mkdir(local);
	await initWithOrigin(local, bare);
	const folder = await openDirectoryHistory({
		root: local,
		git: { author },
	});
	// The fetch itself records the remote head and its objects; a refused
	// Sync must change nothing else.
	const untouched = () => dumpDirectory(local);
	opened.push(folder);
	// Seed the initial remote tree before testing later incoming attributes.
	expect(expectOk(await folder.sync.run()).kind).toBe('synced');

	const text = async (path: string) =>
		decoder.decode(expectOk(await folder.files.read(path)).bytes);
	return {
		folder,
		upstream,
		text,
		/** Commit the upstream working tree and push it. */
		async publish(message: string) {
			// `--force`: the attribute file is ignored by the fixture's own rule.
			await git(upstream, 'add', '--all', '--force');
			await git(upstream, 'commit', '--quiet', '-m', message);
			await git(upstream, 'push', '--quiet', 'origin', 'main');
			return git(upstream, 'rev-parse', 'HEAD');
		},
		/**
		 * Sync is refused for `path` and nothing at all changed: no working
		 * file, no index entry, no ref.
		 */
		async refusedUntouched(path: string, reasonHolds: string) {
			const head = expectOk(await folder.git.log(1))[0]?.oid;
			// Looking at status may refresh the index's stat cache, as `git
			// status` does. Look once first, so the comparison below sees only
			// what the refused Sync itself wrote: nothing.
			expect(expectOk(await folder.git.status()).changes).toEqual([]);
			const before = await untouched();
			const landedBefore = folder.landed.length;

			const refused = expectErr(await folder.sync.run());

			const heard = folder.landed.slice(landedBefore);
			expect(refused.name).toBe('Unrepresentable');
			if (refused.name !== 'Unrepresentable') return;
			expect(refused.paths).toEqual([path]);
			expect(refused.reason).toContain(reasonHolds);
			expect(refused.reason).toContain('names a Git filter');
			expect(await untouched()).toEqual(before);
			expect(expectOk(await folder.git.log(1))[0]?.oid).toBe(head);
			expect(expectOk(await folder.git.status()).changes).toEqual([]);
			expect(heard).toEqual([]);
			expect(await text('rec/take.wav')).toBe('RIFF real audio bytes');
			expect(await text('rec/nested/deep.wav')).toBe('RIFF deeper audio');
		},
	};
}

describe('directory incoming attributes', () => {
	test('an incoming commit that declares an LFS filter is refused before any write', async () => {
		// At the root: the remote starts tracking audio with LFS and replaces
		// the bytes with a pointer.
		const rooted = await incoming();
		await writeFile(
			join(rooted.upstream, '.gitattributes'),
			'*.wav filter=lfs diff=lfs merge=lfs -text\n',
		);
		await writeFile(join(rooted.upstream, 'rec/take.wav'), LFS_POINTER);
		await rooted.publish('track audio with lfs');
		await rooted.refusedUntouched('.gitattributes', 'filter=lfs');
		expect(
			expectErr(await rooted.folder.files.read('.gitattributes')).name,
		).toBe('NotFound');

		// In a nested attribute file, selecting only files below it.
		const nested = await incoming();
		await writeFile(
			join(nested.upstream, 'rec/nested/.gitattributes'),
			'deep.wav filter=lfs\n',
		);
		await writeFile(join(nested.upstream, 'rec/nested/deep.wav'), LFS_POINTER);
		await nested.publish('track one nested file with lfs');
		await nested.refusedUntouched('rec/nested/.gitattributes', 'filter=lfs');
	});

	test('an incoming commit that declares line endings syncs, and each file keeps the bytes the commit stores', async () => {
		const converting = await incoming();
		await writeFile(
			join(converting.upstream, '.gitattributes'),
			'* text=auto\n*.md text eol=crlf\n',
		);
		const head = await converting.publish('normalize markdown line endings');

		expect(expectOk(await converting.folder.sync.run())).toEqual({
			kind: 'synced',
			head,
		});
		expect(await converting.text('notes.md')).toBe('line one\nline two\n');
		expect(await converting.text('.gitattributes')).toBe(
			'* text=auto\n*.md text eol=crlf\n',
		);
		expect(expectOk(await converting.folder.git.status()).changes).toEqual([]);
	});

	test("the folder's own attribute file does not mask the incoming commit's", async () => {
		// In the folder the audio is declared plain; upstream declares a filter.
		const masked = await incoming();
		expectOk(
			await masked.folder.write('.gitattributes', null, '*.wav -filter\n'),
		);
		// Ignored by the committed `.gitignore`, so the folder is still clean.
		expect(expectOk(await masked.folder.git.status()).changes).toEqual([]);
		await writeFile(
			join(masked.upstream, '.gitattributes'),
			'*.wav filter=lfs\n',
		);
		await masked.publish('filter audio');

		const refused = expectErr(await masked.folder.sync.run());
		expect(refused.name).toBe('Unrepresentable');
		if (refused.name === 'Unrepresentable')
			expect(refused.reason).toContain('filter=lfs');
		expect(await masked.text('rec/take.wav')).toBe('RIFF real audio bytes');
		expect(await masked.text('.gitattributes')).toBe('*.wav -filter\n');
	});

	test('pointer-shaped text with no declared filter syncs byte for byte', async () => {
		const plain = await incoming();
		// Someone keeps an LFS pointer as an ordinary file, and declares
		// attributes that change no bytes.
		await writeFile(join(plain.upstream, 'rec/take.wav'), LFS_POINTER);
		await writeFile(join(plain.upstream, 'example-pointer.txt'), LFS_POINTER);
		await writeFile(
			join(plain.upstream, '.gitattributes'),
			'*.wav -text diff=audio\n*.md linguist-documentation\n',
		);
		const head = await plain.publish('keep a pointer as plain text');
		const landedBefore = plain.folder.landed.length;

		expect(expectOk(await plain.folder.sync.run())).toEqual({
			kind: 'synced',
			head,
		});
		// An update that landed reports the paths it reached.
		expect(plain.folder.landed.slice(landedBefore).sort()).toEqual([
			'.gitattributes',
			'example-pointer.txt',
			'rec/take.wav',
		]);
		for (const path of ['rec/take.wav', 'example-pointer.txt'])
			expect(await plain.text(path)).toBe(LFS_POINTER);
		expect(expectOk(await plain.folder.git.log(1))[0]?.oid).toBe(head);
		expect(expectOk(await plain.folder.git.status()).changes).toEqual([]);
	});
});
