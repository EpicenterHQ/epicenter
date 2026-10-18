/**
 * Local Pattern Tests
 *
 * A definition's `local` patterns are lines its own folder's `.gitignore`
 * gets, as a prerequisite: opening the folder adds each one the root
 * `.gitignore` lacks, or fails, and a change through the handle is refused
 * while they cannot be written. From then on `.gitignore` alone decides, read as Git reads it, and
 * both Git backends leave what it ignores out of what Sync commits and sends
 * (ADR-0592).
 *
 * Key behaviors:
 * - A missing `.gitignore` is created; a person's own lines are kept and only
 *   missing patterns are appended
 * - Patterns that cannot be one ignoring line are refused at the declaration
 * - On both backends, Sync sends the rows and never an ignored file; a file
 *   tracked before the rule stays tracked, as in Git; a person's `!`
 *   exception is honoured as Git honours it; and with the `.gitignore`
 *   removed, nothing keeps the audio out
 * - A pattern another device's `.gitignore` brings in by Sync stays there
 *   through the next publication, which only adds lines
 */
import { afterAll, afterEach, beforeAll, expect, test } from 'bun:test';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { Ok } from 'wellcrafted/result';
import { expectErr, expectOk } from 'wellcrafted/testing';
import { openFolder as openBrowserFolder } from './browser.js';
import {
	browserStorage,
	createTestStorage,
} from './browser-storage.test-support.js';
import { openFolder as openBunFolder } from './bun.js';
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
import { hashBytes } from './hash.js';
import { events } from './publication-log.test-support.js';

const { nameLocalPatterns } = await import('./publish-definition.js');

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
	} as unknown as Parameters<typeof nameLocalPatterns>[1];
	return { storage, writes };
}

test('a missing .gitignore is created holding the patterns', async () => {
	const { storage, writes } = gitignoreStorage(undefined);
	expectOk(
		await nameLocalPatterns(['recordings/*.wav', 'recordings/*.webm'], storage),
	);
	expect(writes).toEqual([
		{ text: 'recordings/*.wav\nrecordings/*.webm\n', ifMatch: null },
	]);
});

test("a person's own lines are kept and only missing patterns are appended", async () => {
	const mine = '# mine\n*.log\nrecordings/*.wav';
	const { storage, writes } = gitignoreStorage(mine);
	expectOk(
		await nameLocalPatterns(['recordings/*.wav', 'recordings/*.webm'], storage),
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
	} as unknown as Parameters<typeof nameLocalPatterns>[1];
	expect(expectOk(await nameLocalPatterns(['audio/', 'cache/'], storage))).toBe(
		true,
	);
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
	expect(expectOk(await nameLocalPatterns(['recordings/*.wav'], storage))).toBe(
		false,
	);
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

test("opening the app's own folder writes its .gitignore lines before the handle exists, and fails visibly when it cannot", async () => {
	const root = await scratch('local-open-');
	roots.push(root);
	const own = join(root, 'recorder');
	await mkdir(own);
	const opened = expectOk(
		await openBunFolder({
			app: 'recorder',
			root: own,
			definition,
			git: { author },
		}),
	);
	// Nothing written through the handle yet, and the lines are there.
	expect(await readFile(join(own, '.gitignore'), 'utf8')).toBe('audio/\n');
	await opened.close();

	const blocked = join(root, 'blocked');
	await mkdir(join(blocked, '.gitignore'), { recursive: true });
	const refused = expectErr(
		await openBunFolder({
			app: 'blocked',
			root: blocked,
			definition,
			git: { author },
		}),
	);
	expect(refused).toMatchObject({
		name: 'IgnoreUnwritten',
		patterns: ['audio/'],
	});
});

test('a change is refused while the .gitignore lines cannot be written, so no local file lands unignored', async () => {
	const root = join(await scratch('local-first-write-'), 'recorder');
	roots.push(dirname(root));
	await mkdir(root);
	const folder = expectOk(
		await openBunFolder({ app: 'recorder', root, definition, git: { author } }),
	);
	try {
		// Something replaced the file with what cannot hold the lines.
		await rm(join(root, '.gitignore'));
		await mkdir(join(root, '.gitignore'));
		const refused = expectErr(
			await folder.write('audio/take.wav', null, 'RIFF'),
		);
		expect(refused.message).toContain(
			"Could not name the files this app keeps on this machine in '.gitignore'",
		);
		expect(await readFile(join(root, 'audio/take.wav')).catch(() => null)).toBe(
			null,
		);
		// Once the lines can be written, the change lands behind them.
		await rm(join(root, '.gitignore'), { recursive: true });
		expectOk(await folder.write('audio/take.wav', null, 'RIFF'));
		expect(await readFile(join(root, '.gitignore'), 'utf8')).toBe('audio/\n');
	} finally {
		await folder.close();
	}
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
				'recordings/.epicenter.json',
				'recordings/walk.md',
			]);
			expect(await opened.read('audio/walk.wav')).toBe('RIFF');
		} finally {
			await opened.folder.close();
		}
	});

	test(`${name}: audio tracked before the rule stays tracked, as in Git`, async () => {
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
			// The first write publishes the rule; the tracked take is still
			// source, and a change to it is recorded and sent.
			await recordTake(after.folder, 'run');
			await after.write('audio/walk.wav', 'RIFF, trimmed');
			await at.sync(after.folder);
			expect(await at.remoteTree()).toEqual([
				'.gitignore',
				'audio/walk.wav',
				'recordings/.epicenter.json',
				'recordings/run.md',
				'recordings/walk.md',
			]);
			expect(await after.read('audio/run.wav')).toBe('RIFF');
		} finally {
			await after.folder.close();
		}
	});

	test(`${name}: a pattern Sync brings into .gitignore stays through the next publication`, async () => {
		const at = await fixture();
		const first = await at.open();
		try {
			await recordTake(first.folder, 'walk');
			await at.sync(first.folder);
		} finally {
			await first.folder.close();
		}
		// Another device keeps drafts local too, in the one place that says so.
		await at.push({ '.gitignore': 'audio/\ndrafts/\n' });
		const second = await at.open();
		try {
			await at.sync(second.folder);
			expect(await second.read('.gitignore')).toBe('audio/\ndrafts/\n');
			// The first write publishes again, and only adds lines.
			await recordTake(second.folder, 'run');
			expect(await second.read('.gitignore')).toBe('audio/\ndrafts/\n');
			expect(await second.read('epicenter.json')).toBeUndefined();
		} finally {
			await second.folder.close();
		}
	});

	test(`${name}: an ignored file where the remote adds one stops Sync unread, equal bytes included`, async () => {
		const at = await fixture();
		const opened = await at.open();
		try {
			await recordTake(opened.folder, 'walk');
			await at.sync(opened.folder);
			// Another device commits a take this one keeps ignored, byte for byte.
			await at.push({ 'audio/walk.wav': 'RIFF' });
			const refused = expectErr(await opened.folder.sync.run());
			expect(refused.name).toBe('Blocked');
			expect(refused.message).toContain("'audio/walk.wav'");
			expect(
				expectOk(await opened.folder.git.status()).changes.map(
					({ path }) => path,
				),
			).toEqual([]);
			expect(await opened.read('audio/walk.wav')).toBe('RIFF');
		} finally {
			await opened.folder.close();
		}
	});

	test(`${name}: .gitignore is the only rule: removed, the audio is committed`, async () => {
		const at = await fixture();
		const opened = await at.open();
		try {
			await recordTake(opened.folder, 'walk');
			await opened.remove('.gitignore');
			expect(await opened.read('.gitignore')).toBeUndefined();
			await at.sync(opened.folder);
			expect(await at.remoteTree()).toEqual([
				'audio/walk.wav',
				'recordings/.epicenter.json',
				'recordings/walk.md',
			]);
		} finally {
			await opened.folder.close();
		}
	});

	test(`${name}: a person's ! exception in .gitignore is honoured as Git honours it`, async () => {
		const at = await fixture();
		const opened = await at.open();
		try {
			await recordTake(opened.folder, 'x');
			await recordTake(opened.folder, 'y');
			await opened.write('.gitignore', 'audio/*\n!audio/x.wav\n');
			await at.sync(opened.folder);
			expect(await at.remoteTree()).toEqual([
				'.gitignore',
				'audio/x.wav',
				'recordings/.epicenter.json',
				'recordings/x.md',
				'recordings/y.md',
			]);
		} finally {
			await opened.folder.close();
		}
	});
}
