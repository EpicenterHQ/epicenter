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
 * - A pattern another device's declaration brings in by Sync reaches
 *   `.gitignore` with the next publication
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
import {
	defineFolder,
	defineTable,
	field,
	formatDeclaration,
} from './contract.js';
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
import { hashBytes } from './hash.js';
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

/** `.gitignore` storage whose puts the test records; reads answer `text`, or NotFound. */
function gitignoreStorage(text: string | undefined) {
	const writes: { text: string; ifMatch: string | null }[] = [];
	const storage = {
		read: async (path: string) => {
			if (text === undefined) return FileError.NotFound({ path });
			const bytes = encode(text);
			return Ok({ bytes, sha256: await hashBytes(bytes) });
		},
		put: async (
			path: string,
			bytes: Uint8Array | null,
			ifMatch: string | null,
		) => {
			expect(path).toBe('.gitignore');
			writes.push({ text: decode(bytes ?? new Uint8Array()), ifMatch });
			text = bytes === null ? undefined : decode(bytes);
			return Ok('landed');
		},
	} as unknown as Parameters<typeof publishLocalPatterns>[1];
	return { storage, writes };
}

test('a missing .gitignore is created holding the patterns', async () => {
	const { storage, writes } = gitignoreStorage(undefined);
	await publishLocalPatterns(
		['recordings/*.wav', 'recordings/*.webm'],
		storage,
	);
	expect(writes).toEqual([
		{ text: 'recordings/*.wav\nrecordings/*.webm\n', ifMatch: null },
	]);
});

test("a person's own lines are kept and only missing patterns are appended", async () => {
	const mine = '# mine\n*.log\nrecordings/*.wav';
	const { storage, writes } = gitignoreStorage(mine);
	await publishLocalPatterns(
		['recordings/*.wav', 'recordings/*.webm'],
		storage,
	);
	expect(writes).toEqual([
		{
			text: '# mine\n*.log\nrecordings/*.wav\nrecordings/*.webm\n',
			ifMatch: await hashBytes(encode(mine)),
		},
	]);
	expect(events).toEqual([]);
});

test('a pattern another writer removes while publication writes is named again', async () => {
	let text = 'audio/\n';
	let reads = 0;
	const storage = {
		read: async () => {
			// Another writer removes `audio/` after publication read the file
			// and before its write reads it again.
			if (++reads === 2) text = '';
			const bytes = encode(text);
			return Ok({ bytes, sha256: await hashBytes(bytes) });
		},
		put: async (_path: string, bytes: Uint8Array | null) => {
			text = decode(bytes ?? new Uint8Array());
			return Ok('landed');
		},
	} as unknown as Parameters<typeof publishLocalPatterns>[1];
	await publishLocalPatterns(['audio/', 'cache/'], storage);
	expect(
		text
			.split('\n')
			.filter((line) => line !== '')
			.sort(),
	).toEqual(['audio/', 'cache/']);
	expect(events).toEqual([]);
});

test('a .gitignore already naming every pattern is not written', async () => {
	const { storage, writes } = gitignoreStorage('*.log\r\nrecordings/*.wav\r\n');
	await publishLocalPatterns(['recordings/*.wav'], storage);
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
	/** Another device commits `files` and pushes them to the remote. */
	push(files: Record<string, string>): Promise<void>;
	/** Sync once, as the person would. */
	sync(folder: { sync: { run(): Promise<unknown> } }): Promise<void>;
};

/** A clone of `bare` in `root` that commits and pushes as another device would. */
function anotherDevice(root: string, bare: string) {
	const other = join(root, 'other');
	return async (files: Record<string, string>) => {
		await rm(other, { recursive: true, force: true });
		await git(root, 'clone', '--quiet', bare, other);
		for (const [path, text] of Object.entries(files)) {
			await mkdir(dirname(join(other, path)), { recursive: true });
			await writeFile(join(other, path), text);
			await git(other, 'add', '--force', path);
		}
		await git(other, 'commit', '--quiet', '-m', 'Other device');
		await git(other, 'push', '--quiet', 'origin', 'HEAD:main');
	};
}

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
					app: 'local-patterns',
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
					expectOk(await folder.write(path, current?.bytes ?? null, text));
				},
				async remove(path) {
					expectOk(await folder.write(path, null, null));
				},
			};
		},
		remoteTree: async () =>
			(await git(bare, 'ls-tree', '-r', '--name-only', 'main'))
				.split('\n')
				.sort(),
		push: anotherDevice(root, bare),
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
		push: anotherDevice(root, bare),
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
		expectOk(await folder.write(`audio/${stem}.wav`, null, 'RIFF'));
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

	test(`${name}: a pattern Sync brings in reaches .gitignore on the next publication`, async () => {
		const at = await fixture();
		const first = await at.open();
		try {
			await recordTake(first.folder, 'walk');
			await at.sync(first.folder);
		} finally {
			await first.folder.close();
		}
		// Another device's declaration keeps drafts local too; nothing it
		// pushes adds the pattern to `.gitignore`.
		await at.push({
			'epicenter.json': formatDeclaration(
				defineFolder({ tables, local: ['audio/', 'drafts/'] }),
			),
		});
		const second = await at.open();
		try {
			await at.sync(second.folder);
			expect(await second.read('.gitignore')).toBe('audio/\n');
			// The first write publishes again: `epicenter.json` keeps both
			// patterns, and `.gitignore` names both.
			await recordTake(second.folder, 'run');
			expect(
				JSON.parse((await second.read('epicenter.json')) ?? '{}').local,
			).toEqual(['audio/', 'drafts/']);
			expect(await second.read('.gitignore')).toBe('audio/\ndrafts/\n');
		} finally {
			await second.folder.close();
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
