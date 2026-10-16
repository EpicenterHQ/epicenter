/**
 * Local Pattern Tests
 *
 * A definition's `local` patterns name files that stay on the machine that
 * wrote them. Before its first write a handle adds each one the root
 * `.gitignore` lacks, and both Git backends then leave the files out of what
 * Sync commits and sends.
 *
 * Key behaviors:
 * - A missing `.gitignore` is created; a person's own lines are kept and only
 *   missing patterns are appended
 * - Patterns that cannot be one ignoring line are refused at the declaration
 * - On both backends, Sync sends the rows and never a local file: not with
 *   the `.gitignore` in place, not without it, not past a person's `!`
 *   exception, and one committed before the rule is untracked, its bytes
 *   kept on disk and out of the pushed tree
 */
import { afterAll, afterEach, beforeAll, expect, test } from 'bun:test';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { Ok } from 'wellcrafted/result';
import { expectOk } from 'wellcrafted/testing';
import { openFolder as openBrowserFolder } from './browser.js';
import {
	browserStorage,
	createTestStorage,
} from './browser-storage.test-support.js';
import { fileCapture, hashBytes } from './capture.js';
import { defineFolder, defineTable, field } from './contract.js';
import { openNativeFolder } from './directory.test-support.js';
import { FileError } from './errors.js';
import {
	createBareRemote,
	GIT_ENV,
	git,
	gitHttpFetch,
	initWithOrigin,
	scratch,
} from './git-http.test-support.js';
import { events } from './publication-log.test-support.js';

const { publishLocalPatterns } = await import('./publish-definition.js');

const tables = {
	recordings: defineTable({ fields: { title: field.string() } }),
};
const definition = defineFolder({ tables, local: ['audio/'] });
/** The same folder before it declared its audio local. */
const unruled = defineFolder({ tables });
const author = { name: 'Recorder', email: 'recorder@example.test' };
const originalGlobal = process.env.GIT_CONFIG_GLOBAL;
const roots: string[] = [];

beforeAll(() => {
	process.env.GIT_CONFIG_GLOBAL = GIT_ENV.GIT_CONFIG_GLOBAL;
});
afterAll(() => {
	if (originalGlobal === undefined) delete process.env.GIT_CONFIG_GLOBAL;
	else process.env.GIT_CONFIG_GLOBAL = originalGlobal;
});
afterEach(async () => {
	events.length = 0;
	for (const root of roots.splice(0))
		await rm(root, { recursive: true, force: true });
});

const encode = (text: string) => new TextEncoder().encode(text);
const decode = (bytes: Uint8Array) => new TextDecoder().decode(bytes);

/** `.gitignore` files whose writes the test records; reads answer `text`, or NotFound. */
function gitignoreFiles(text: string | undefined) {
	const writes: { verb: 'create' | 'save'; text: string; options?: unknown }[] =
		[];
	const files = {
		read: async (path: string) => {
			if (text === undefined) return FileError.NotFound({ path });
			const bytes = encode(text);
			return Ok({ ...fileCapture(path, await hashBytes(bytes)), bytes });
		},
		create: async (path: string, content: string) => {
			expect(path).toBe('.gitignore');
			writes.push({ verb: 'create', text: content });
			return Ok(fileCapture(path, '0'.repeat(64)));
		},
		save: async (
			base: { path: string },
			content: string,
			options?: unknown,
		) => {
			expect(base.path).toBe('.gitignore');
			writes.push({ verb: 'save', text: content, options });
			return Ok(fileCapture(base.path, '0'.repeat(64)));
		},
	} as unknown as Parameters<typeof publishLocalPatterns>[1];
	return { files, writes };
}

test('a missing .gitignore is created holding the patterns', async () => {
	const { files, writes } = gitignoreFiles(undefined);
	await publishLocalPatterns(['recordings/*.wav', 'recordings/*.webm'], files);
	expect(writes).toEqual([
		{ verb: 'create', text: 'recordings/*.wav\nrecordings/*.webm\n' },
	]);
});

test("a person's own lines are kept and only missing patterns are appended", async () => {
	const { files, writes } = gitignoreFiles('# mine\n*.log\nrecordings/*.wav');
	await publishLocalPatterns(['recordings/*.wav', 'recordings/*.webm'], files);
	expect(writes).toEqual([
		{
			verb: 'save',
			text: '# mine\n*.log\nrecordings/*.wav\nrecordings/*.webm\n',
			options: { merge: false },
		},
	]);
	expect(events).toEqual([]);
});

test('a .gitignore already naming every pattern is not written', async () => {
	const { files, writes } = gitignoreFiles('*.log\r\nrecordings/*.wav\r\n');
	await publishLocalPatterns(['recordings/*.wav'], files);
	expect(writes).toEqual([]);
});

for (const [name, local] of [
	['a comment', ['# audio']],
	['a negation', ['!recordings/*.md']],
	['two lines', ['a\nb']],
	['surrounding whitespace', [' recordings/ ']],
	['an empty pattern', ['']],
] as const)
	test(`${name} is refused at the declaration`, () => {
		expect(() => defineFolder({ tables: {}, local: [...local] })).toThrow();
	});

type Opened = {
	/** The folder, opened with `withDefinition`. */
	open(withDefinition?: typeof definition | typeof unruled): Promise<{
		folder: Awaited<ReturnType<typeof openNativeFolder<typeof definition>>>;
		/** Read a folder file's text, or undefined when absent. */
		read(path: string): Promise<string | undefined>;
		write(path: string, text: string): Promise<void>;
		remove(path: string): Promise<void>;
	}>;
	/** The paths in the remote's `main` tree. */
	remoteTree(): Promise<string[]>;
	/** Sync once, as the person would. */
	sync(folder: { sync: { run(): Promise<unknown> } }): Promise<void>;
};

/** A browser folder over one in-memory store, syncing to a bare remote over HTTP. */
async function browserFixture(): Promise<Opened> {
	const root = await scratch('local-browser-');
	roots.push(root);
	const bare = await createBareRemote(root);
	const storage = createTestStorage();
	const httpFetch = await gitHttpFetch(root);
	let connected = false;
	return {
		async open(withDefinition = definition) {
			const folder = expectOk(
				await openBrowserFolder({
					id: 'local-patterns',
					definition: withDefinition,
					browser: { author, httpFetch, ...browserStorage(storage) },
				}),
			) as never as Awaited<
				ReturnType<typeof openNativeFolder<typeof definition>>
			>;
			return {
				folder,
				async read(path) {
					const { data, error } = await folder.files.read(path);
					return error === null ? decode(data.bytes) : undefined;
				},
				async write(path, text) {
					const { data: current } = await folder.files.read(path);
					if (current)
						expectOk(await folder.files.save(current, text, { merge: false }));
					else expectOk(await folder.files.create(path, text));
				},
				async remove(path) {
					const { data: current } = await folder.files.read(path);
					if (current) expectOk(await folder.files.remove(current));
				},
			};
		},
		remoteTree: async () =>
			(await git(bare, 'ls-tree', '-r', '--name-only', 'main'))
				.split('\n')
				.sort(),
		async sync(folder) {
			const run = connected
				? folder.sync.run()
				: (
						folder.sync as unknown as { connect(url: string): Promise<unknown> }
					).connect('http://git.test/remote.git');
			connected = true;
			expect(expectOk((await run) as never)).toMatchObject({ kind: 'synced' });
		},
	};
}

/** A directory folder with system Git, syncing to a bare remote on disk. */
async function nativeFixture(): Promise<Opened> {
	const root = await scratch('local-native-');
	roots.push(root);
	const bare = join(root, 'remote.git');
	await git(root, 'init', '--quiet', '--bare', '--initial-branch=main', bare);
	const directory = join(root, 'folder');
	await initWithOrigin(directory, bare);
	return {
		async open(withDefinition = definition) {
			const folder = await openNativeFolder({
				root: directory,
				definition: withDefinition as typeof definition,
				git: { author },
			});
			return {
				folder,
				read: (path) =>
					readFile(join(directory, path), 'utf8').catch(() => undefined),
				async write(path, text) {
					await mkdir(dirname(join(directory, path)), { recursive: true });
					await writeFile(join(directory, path), text);
				},
				remove: (path) => rm(join(directory, path), { force: true }),
			};
		},
		remoteTree: async () =>
			(await git(bare, 'ls-tree', '-r', '--name-only', 'main'))
				.split('\n')
				.sort(),
		async sync(folder) {
			expect(expectOk((await folder.sync.run()) as never)).toMatchObject({
				kind: 'synced',
			});
		},
	};
}

for (const [name, fixture] of [
	['browser', browserFixture],
	['native', nativeFixture],
] as const) {
	/** A row and a recording's audio, written through the folder. */
	async function recordTake(
		folder: Awaited<ReturnType<Opened['open']>>['folder'],
		stem: string,
	) {
		expectOk(
			await folder.tables.recordings.create(
				{ fields: { title: stem }, body: '' },
				{ stem },
			),
		);
		expectOk(await folder.files.create(`audio/${stem}.wav`, 'RIFF'));
	}

	test(`${name}: Sync sends the row and the .gitignore, never the audio`, async () => {
		const at = await fixture();
		const opened = await at.open();
		try {
			await recordTake(opened.folder, 'walk');
			expect(await opened.read('.gitignore')).toBe('audio/\n');
			await at.sync(opened.folder);
			expect(await at.remoteTree()).toEqual([
				'.gitignore',
				'epicenter.json',
				'recordings/walk.md',
			]);
			expect(await opened.read('audio/walk.wav')).toBe('RIFF');
		} finally {
			await opened.folder.close();
		}
	});

	test(`${name}: audio committed before the rule is untracked by the next Sync and kept on disk`, async () => {
		const at = await fixture();
		const before = await at.open(unruled);
		try {
			await recordTake(before.folder, 'walk');
			await at.sync(before.folder);
			expect(await at.remoteTree()).toContain('audio/walk.wav');
		} finally {
			await before.folder.close();
		}
		const after = await at.open();
		try {
			// The first write publishes the rule.
			await recordTake(after.folder, 'run');
			await at.sync(after.folder);
			expect(await at.remoteTree()).toEqual([
				'.gitignore',
				'epicenter.json',
				'recordings/run.md',
				'recordings/walk.md',
			]);
			expect(await after.read('audio/walk.wav')).toBe('RIFF');
			expect(await after.read('audio/run.wav')).toBe('RIFF');
		} finally {
			await after.folder.close();
		}
	});

	test(`${name}: without a .gitignore, Sync still leaves the audio out`, async () => {
		const at = await fixture();
		const opened = await at.open();
		try {
			await recordTake(opened.folder, 'walk');
			await opened.remove('.gitignore');
			expect(await opened.read('.gitignore')).toBeUndefined();
			await at.sync(opened.folder);
			expect(await at.remoteTree()).toEqual([
				'epicenter.json',
				'recordings/walk.md',
			]);
		} finally {
			await opened.folder.close();
		}
	});

	test(`${name}: a person's ! exception in .gitignore does not get the audio committed`, async () => {
		const at = await fixture();
		const opened = await at.open();
		try {
			await recordTake(opened.folder, 'x');
			// Plain `git add -A` would now take audio/x.wav.
			await opened.write('.gitignore', 'audio/*\n!audio/x.wav\n');
			await at.sync(opened.folder);
			expect(await at.remoteTree()).toEqual([
				'.gitignore',
				'epicenter.json',
				'recordings/x.md',
			]);
		} finally {
			await opened.folder.close();
		}
	});
}
