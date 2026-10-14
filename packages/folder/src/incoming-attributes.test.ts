/**
 * Incoming Attribute Refusal Tests
 *
 * A fast-forward writes each incoming blob's bytes as they are stored. A
 * commit that declares a Git filter or a byte conversion means something else
 * by those bytes, so the pull is refused before a file, the index, or the
 * branch changes. The desktop owner makes the same refusal in Rust; these run
 * the same cases against a browser folder and a directory folder.
 *
 * Key behaviors:
 * - An LFS filter at the root or in a nested attribute file is refused, with
 *   the audio in the folder still the audio
 * - A commit that only adds an attribute, over files it does not change, is
 *   refused
 * - Attributes of the files currently in the folder do not mask the incoming
 *   commit's
 * - Nothing is published on refusal: working bytes, index, and HEAD are equal
 *   before and after
 * - Pointer-shaped text with no declared filter is ordinary bytes and
 *   fast-forwards exactly. This is refusal of filters, not LFS support
 *
 * See also:
 * - `git/attributes.test.ts` for the browser evaluation against real Git
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
import { openFolder as openBrowserFolder } from './browser.js';
import {
	browserStorage,
	configureRemote,
	createTestStorage,
	dumpStorage,
} from './browser-storage.test-support.js';
import { defineFolder, type Folder } from './contract.js';
import { formatDeclaration } from './declaration.js';
import { openNativeFolder } from './directory.test-support.js';
import {
	createBareRemote,
	git,
	GIT_ENV,
	gitHttpFetch,
	initWithOrigin,
	scratch,
} from './git-http.test-support.js';

const definition = defineFolder({
	kv: {},
	tables: {},
});
type Opened = Folder<typeof definition>;
const author = { name: 'Reader', email: 'reader@example.test' };
const decoder = new TextDecoder();

/** A valid Git LFS pointer. No LFS program is involved in writing it here. */
const LFS_POINTER =
	'version https://git-lfs.github.com/spec/v1\noid sha256:4d7a214614ab2935c943f9e0ff69d22eadbb8f32b1258daaa5e2ca24d17e2393\nsize 12345\n';

const originalFetch = globalThis.fetch;
const originalEnv = { ...process.env };
beforeAll(() => {
	Object.assign(process.env, {
		GIT_CONFIG_GLOBAL: GIT_ENV.GIT_CONFIG_GLOBAL,
		GIT_CONFIG_NOSYSTEM: '1',
	});
});
afterAll(() => {
	globalThis.fetch = originalFetch;
	for (const key of ['GIT_CONFIG_GLOBAL', 'GIT_CONFIG_NOSYSTEM'])
		if (originalEnv[key] === undefined) delete process.env[key];
		else process.env[key] = originalEnv[key];
});

const opened: Opened[] = [];
afterEach(async () => {
	for (const folder of opened.splice(0)) await folder.close();
	globalThis.fetch = originalFetch;
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
async function incoming(kind: 'browser' | 'directory') {
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
	// The declaration a folder of this definition publishes before its first
	// write, so that write leaves the folder clean.
	await writeFile(
		join(upstream, 'epicenter.json'),
		formatDeclaration(definition),
	);
	await git(upstream, 'add', '--all');
	await git(upstream, 'commit', '--quiet', '-m', 'audio');
	await git(upstream, 'push', '--quiet', 'origin', 'main');

	let folder: Opened;
	let untouched: () => Promise<Record<string, string>>;
	if (kind === 'browser') {
		globalThis.fetch = await gitHttpFetch(root);
		const environment = createTestStorage();
		await configureRemote(
			environment,
			'so.epicenter.incomingtest',
			'http://git.test/remote.git',
		);
		folder = expectOk(
			await openBrowserFolder({
				id: 'so.epicenter.incomingtest',
				definition,
				browser: {
					author,
					...browserStorage(environment),
				},
			}),
		);
		// The fetch itself records the remote head and its objects; a refused
		// pull must change nothing else.
		untouched = () =>
			dumpStorage(
				environment,
				'so.epicenter.incomingtest',
				(key) =>
					key.startsWith('/git/objects/') ||
					key.startsWith('/git/refs/remotes/') ||
					key === '/git/FETCH_HEAD',
			);
	} else {
		const local = join(root, 'local');
		await mkdir(local);
		await initWithOrigin(local, bare);
		folder = await openNativeFolder({
			root: local,
			definition,
			git: { author },
		});
		untouched = () => dumpDirectory(local);
	}
	opened.push(folder);
	// Seed the initial remote tree before testing later incoming attributes.
	expectOk(await folder.git.fetch());
	expect(expectOk(await folder.git.pullFastForward()).status).toBe(
		'fastForwarded',
	);

	const text = async (path: string) =>
		decoder.decode(expectOk(await folder.files.read(path)).bytes);
	return {
		folder,
		upstream,
		text,
		/** Commit the upstream working tree and make it the fetched head. */
		async publish(message: string) {
			// `--force`: the attribute file is ignored by the fixture's own rule.
			await git(upstream, 'add', '--all', '--force');
			await git(upstream, 'commit', '--quiet', '-m', message);
			await git(upstream, 'push', '--quiet', 'origin', 'main');
			return expectOk(await folder.git.fetch()).oid;
		},
		/**
		 * The fast-forward is refused for `path` and nothing at all changed: no
		 * working file, no index entry, no ref.
		 */
		async refusedUntouched(path: string, reasonHolds: string) {
			const head = expectOk(await folder.git.log(1))[0]?.oid;
			// Looking at a browser folder's status refreshes the index's stat
			// cache, as `git status` does. Look once first, so the comparison
			// below sees only what the refused pull itself wrote: nothing.
			expect(expectOk(await folder.git.paths())).toEqual([]);
			const before = await untouched();
			const heard: string[] = [];
			const stop = folder.onFilesChanged((paths) => heard.push(...paths));

			const refused = expectErr(await folder.git.pullFastForward());

			stop();
			expect(refused.name).toBe('Unrepresentable');
			if (refused.name !== 'Unrepresentable') return;
			expect(refused.paths).toEqual([path]);
			expect(refused.reason).toContain(reasonHolds);
			expect(refused.reason).toContain(
				'this folder does not apply attribute filters or conversion',
			);
			expect(await untouched()).toEqual(before);
			expect(expectOk(await folder.git.log(1))[0]?.oid).toBe(head);
			expect(expectOk(await folder.git.paths())).toEqual([]);
			expect(expectOk(await folder.git.status()).changes).toEqual([]);
			expect(heard).toEqual([]);
			expect(await text('rec/take.wav')).toBe('RIFF real audio bytes');
			expect(await text('rec/nested/deep.wav')).toBe('RIFF deeper audio');
		},
	};
}

describe.each([
	'browser',
	'directory',
] as const)('%s folder incoming attributes', (kind) => {
	test('an incoming commit that declares an LFS filter is refused before any write', async () => {
		// At the root: the remote starts tracking audio with LFS and replaces
		// the bytes with a pointer.
		const rooted = await incoming(kind);
		await writeFile(
			join(rooted.upstream, '.gitattributes'),
			'*.wav filter=lfs diff=lfs merge=lfs -text\n',
		);
		await writeFile(join(rooted.upstream, 'rec/take.wav'), LFS_POINTER);
		await rooted.publish('track audio with lfs');
		await rooted.refusedUntouched('rec/nested/deep.wav', 'filter=lfs');
		expect(
			expectErr(await rooted.folder.files.read('.gitattributes')).name,
		).toBe('NotFound');

		// In a nested attribute file, selecting only files below it.
		const nested = await incoming(kind);
		await writeFile(
			join(nested.upstream, 'rec/nested/.gitattributes'),
			'deep.wav filter=lfs\n',
		);
		await writeFile(join(nested.upstream, 'rec/nested/deep.wav'), LFS_POINTER);
		await nested.publish('track one nested file with lfs');
		await nested.refusedUntouched('rec/nested/deep.wav', 'filter=lfs');
	});

	test('an incoming normalizing attribute is refused even when it only selects unchanged files', async () => {
		// Line-ending conversion declared for a file the commit does not touch.
		const converting = await incoming(kind);
		await writeFile(
			join(converting.upstream, '.gitattributes'),
			'*.md text eol=crlf\n',
		);
		await converting.publish('normalize markdown line endings');
		await converting.refusedUntouched('notes.md', 'text');
	});

	test("the folder's own attribute file does not mask the incoming commit's", async () => {
		// In the folder the audio is declared plain; upstream declares a filter.
		const masked = await incoming(kind);
		expectOk(
			await masked.folder.files.create('.gitattributes', '*.wav -filter\n'),
		);
		// Ignored by the committed `.gitignore`, and the declaration this first
		// write published matches the committed one, so the folder is still clean.
		expect(expectOk(await masked.folder.git.status()).changes).toEqual([]);
		await writeFile(
			join(masked.upstream, '.gitattributes'),
			'*.wav filter=lfs\n',
		);
		await masked.publish('filter audio');

		const refused = expectErr(await masked.folder.git.pullFastForward());
		expect(refused.name).toBe('Unrepresentable');
		if (refused.name === 'Unrepresentable')
			expect(refused.reason).toContain('filter=lfs');
		expect(await masked.text('rec/take.wav')).toBe('RIFF real audio bytes');
		expect(await masked.text('.gitattributes')).toBe('*.wav -filter\n');
	});

	test('pointer-shaped text with no declared filter fast-forwards byte for byte', async () => {
		const plain = await incoming(kind);
		// Someone keeps an LFS pointer as an ordinary file, and declares
		// attributes that change no bytes.
		await writeFile(join(plain.upstream, 'rec/take.wav'), LFS_POINTER);
		await writeFile(join(plain.upstream, 'example-pointer.txt'), LFS_POINTER);
		await writeFile(
			join(plain.upstream, '.gitattributes'),
			'*.wav -text diff=audio\n*.md linguist-documentation\n',
		);
		const head = await plain.publish('keep a pointer as plain text');
		const heard: string[] = [];
		plain.folder.onFilesChanged((paths) => heard.push(...paths));

		const pulled = expectOk(await plain.folder.git.pullFastForward());
		expect(pulled).toMatchObject({ status: 'fastForwarded', to: head });
		if (pulled.status !== 'fastForwarded') return;
		expect([...pulled.changedPaths].sort()).toEqual([
			'.gitattributes',
			'example-pointer.txt',
			'rec/take.wav',
		]);
		// An update that landed is announced, with the paths it reached.
		expect(heard.sort()).toEqual([
			'.gitattributes',
			'example-pointer.txt',
			'rec/take.wav',
		]);
		for (const path of ['rec/take.wav', 'example-pointer.txt'])
			expect(await plain.text(path)).toBe(LFS_POINTER);
		expect(expectOk(await plain.folder.git.log(1))[0]?.oid).toBe(head);
		expect(expectOk(await plain.folder.git.status()).changes).toEqual([]);
		expect(expectOk(await plain.folder.git.paths())).toEqual([]);
	});
});
