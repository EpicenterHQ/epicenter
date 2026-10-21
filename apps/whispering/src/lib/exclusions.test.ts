/**
 * App-maintained exclusions over real native and IndexedDB file saves.
 * Startup preserves source bytes, respects ordered Git rules, skips effective
 * exclusions, merges concurrent edits, and reports failures without replacing
 * unreadable content or claiming that an ineffective merge installed a rule.
 */
import 'fake-indexeddb/auto';
import { afterEach, expect, test } from 'bun:test';
import { readdir } from 'node:fs/promises';
import { type FolderFiles, ReadError, SaveError } from '@epicenter/folder';
import { Ok } from 'wellcrafted/result';
import { expectErr, expectOk } from 'wellcrafted/testing';
import { readSnapshot } from '../../../../packages/folder/src/browser/git/snapshot.js';
import { openRepository } from '../../../../packages/folder/src/browser/repository.js';
import { prepareCommit } from '../../../../packages/folder/src/browser/sync.js';
import { readCommit } from '../../../../packages/folder/src/git/raw-objects.js';
import { maintainExclusions } from './exclusions.js';
import { deferred, openTestServices } from './services.test-support.js';

const cleanups: (() => Promise<void> | void)[] = [];
const rules = [
	'/recordings/*.[wW][aA][vV]',
	'/recordings/*.[wW][eE][bB][mM]',
	'/recordings/*.[mM]4[aA]',
	'/recordings/*.[mM][pP]4',
	'/recordings/*.[oO][gG][gG]',
	'/recordings/*.[oO][gG][aA]',
	'/recordings/*.[oO][pP][uU][sS]',
	'/recordings/*.[mM][pP]3',
	'/recordings/*.[fF][lL][aA][cC]',
	'/recordings/*.[aA][aA][cC]',
	'',
].join('\n');
afterEach(async () => {
	for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

async function open(source?: string | Uint8Array) {
	const services = await openTestServices();
	const files = services.folder.files;
	cleanups.push(async () => {
		await services.folder.close();
		await services.remove();
	});
	if (source !== undefined)
		expectOk(await files.write('.gitignore', null, source));
	return { files, root: services.root };
}

/** A repository's files as a folder answers them: a write answers no stored content. */
function filesOf(repository: Awaited<ReturnType<typeof openRepository>>) {
	const { files } = repository;
	return {
		...files,
		async write(...args: Parameters<typeof files.write>) {
			const written = await files.write(...args);
			return written.error === null ? Ok(undefined) : written;
		},
	} satisfies Pick<FolderFiles, 'read' | 'write'>;
}

async function text(files: Pick<FolderFiles, 'read'>) {
	return expectOk(await files.read('.gitignore'))?.content.text();
}

test('an empty folder gets only an ordinary .gitignore, and another startup writes nothing', async () => {
	const { files, root } = await open();
	expectOk(await maintainExclusions(files));
	expect(await text(files)).toBe(rules);
	expect(await readdir(root)).toEqual(['.gitignore']);
	let writes = 0;
	expectOk(
		await maintainExclusions({
			...files,
			write: async (...args) => {
				writes++;
				return files.write(...args);
			},
		}),
	);
	expect(writes).toBe(0);
});

test.each([
	['# another app\n/cache/', `# another app\n/cache/\n${rules}`],
	['/recordings/\n!/recordings/\n', `/recordings/\n!/recordings/\n${rules}`],
	['/audio/\n', `/audio/\n${rules}`],
	['/RECORDINGS/\n', `/RECORDINGS/\n${rules}`],
	[
		'\ufeff# café\r\n/cache/',
		`\ufeff# café\r\n/cache/\r\n${rules.replaceAll('\n', '\r\n')}`,
	],
])(
	'adds or restores the root exclusion while preserving %j',
	async (before, after) => {
		const { files } = await open(before);
		let supplied: Parameters<FolderFiles['write']>[1] | undefined;
		expectOk(
			await maintainExclusions({
				...files,
				write: async (path, from, change) => {
					supplied = from;
					return files.write(path, from, change);
				},
			}),
		);
		expect(supplied).toEqual(new TextEncoder().encode(before));
		const saved = expectOk(await files.read('.gitignore'))!;
		expect(new Uint8Array(await saved.content.arrayBuffer())).toEqual(
			new TextEncoder().encode(after),
		);
		// Another app can append its own rule without making ours append again.
		expectOk(await files.write('.gitignore', after, `${after}/private/\n`));
		expectOk(await maintainExclusions(files));
		expect(await text(files)).toEndWith('/private/\n');
	},
);

test.each([
	'/recordings/\n',
	'recordings/*\n',
	'*\n',
	'\ufeff/recordings/\r\n',
])('effective directory rules cause no write: %j', async (before) => {
	const { files } = await open(before);
	let writes = 0;
	expectOk(
		await maintainExclusions({
			...files,
			write: async (...args) => {
				writes++;
				return files.write(...args);
			},
		}),
	);
	expect(writes).toBe(0);
});

test.each([new Uint8Array([0xff, 0xfe]), new Uint8Array([97, 0, 98])])(
	'non-text rules stay byte-for-byte intact: %j',
	async (before) => {
		const { files } = await open(before);
		expect(expectErr(await maintainExclusions(files)).name).toBe(
			'InvalidIgnoreText',
		);
		const saved = expectOk(await files.read('.gitignore'))!;
		expect(new Uint8Array(await saved.content.arrayBuffer())).toEqual(before);
	},
);

test('read and save refusals propagate without inventing successful installation', async () => {
	const { files } = await open('# keep\n');
	const readFailure = ReadError.StorageFailed({
		cause: new Error('read refused'),
	});
	expect(
		expectErr(
			await maintainExclusions({ ...files, read: async () => readFailure }),
		),
	).toBe(readFailure.error);
	const saveFailure = SaveError.StorageFailed({
		cause: new Error('write refused'),
	});
	expect(
		expectErr(
			await maintainExclusions({ ...files, write: async () => saveFailure }),
		),
	).toBe(saveFailure.error);
	expect(await text(files)).toBe('# keep\n');
});

test('a concurrent edit after reading survives the startup save', async () => {
	const { files } = await open('# keep\n');
	expectOk(
		await maintainExclusions({
			...files,
			write: async (path, from, change) => {
				expectOk(await files.write(path, from, '# keep\n/private/\n'));
				return files.write(path, from, change);
			},
		}),
	);
	expect(await text(files)).toBe(`# keep\n/private/\n${rules}`);
});

test('a successful save followed by a conflicting rule reports ineffective installation without retrying', async () => {
	const { files } = await open();
	let writes = 0;
	const refused = expectErr(
		await maintainExclusions({
			...files,
			write: async (...args) => {
				writes++;
				const saved = await files.write(...args);
				expectOk(saved);
				expectOk(
					await files.write('.gitignore', rules, `${rules}!/recordings/*\n`),
				);
				return saved;
			},
		}),
	);
	expect(refused.name).toBe('NotExcluded');
	expect(writes).toBe(1);
	expect(await text(files)).toBe(`${rules}!/recordings/*\n`);
});

test('two browser connections starting from the same bytes retain both the rule and another edit after reopening', async () => {
	const id = crypto.randomUUID();
	const a = await openRepository(id);
	const b = await openRepository(id);
	cleanups.push(() => {
		a.close();
		b.close();
	});
	expectOk(await a.files.write('.gitignore', null, '# keep\n'));
	const begun = deferred<void>();
	const release = deferred<void>();
	const updating = maintainExclusions({
		...filesOf(a),
		write: async (...args) => {
			begun.resolve();
			await release.promise;
			return filesOf(a).write(...args);
		},
	});
	await begun.promise;
	expectOk(
		await b.files.write('.gitignore', '# keep\n', '# keep\n/private/\n'),
	);
	expectOk(await maintainExclusions(filesOf(b)));
	release.resolve();
	expectOk(await updating);
	a.close();
	b.close();
	const reopened = await openRepository(id);
	cleanups.push(() => reopened.close());
	expect(await text(reopened.files)).toBe(`# keep\n/private/\n${rules}`);
});

test('startup rules exclude new audio from commit preparation while preserving offline bytes and an exact pending send', async () => {
	const repository = await openRepository(crypto.randomUUID());
	cleanups.push(() => repository.close());
	const { storage } = repository;
	const files = filesOf(repository);
	const audio = new Uint8Array([0, 255, 1]);
	expectOk(await files.write('recordings/take.wav', null, audio));
	expectOk(await files.write('recordings/take.WEBM', null, audio));
	expectOk(await files.write('recordings/take.md', null, 'Recording\n'));
	expectOk(
		await files.write(
			'recordings/attachment.pdf',
			null,
			new Uint8Array([1, 2]),
		),
	);
	expectOk(await files.write('notes/one.md', null, 'Offline note\n'));
	expectOk(await maintainExclusions(files));
	// A simulated first observation of an empty remote, not a network call.
	const { state } = await storage.capture([]);
	expect(
		await storage.publish({
			expected: state,
			refs: { remoteBase: null, pendingCommit: null },
		}),
	).toBe(true);
	const author = { name: 'Test', email: 'test@example.com', timestamp: 1 };
	const pending = (await prepareCommit(storage, author))!;
	const captured = await storage.capture('sync');
	const commit = readCommit(captured.objects.get(pending.head)!.bytes);
	const tree = await readSnapshot(
		commit.tree,
		async (oid) => captured.objects.get(oid)!,
	);
	expect([...tree.files.keys()].sort()).toEqual([
		'.gitignore',
		'notes/one.md',
		'recordings/attachment.pdf',
		'recordings/take.md',
	]);
	const localAudio = expectOk(await files.read('recordings/take.wav'))!;
	expect(new Uint8Array(await localAudio.content.arrayBuffer())).toEqual(audio);
	expectOk(
		await files.write('.gitignore', rules, '# changed after preparing\n'),
	);
	expectOk(await maintainExclusions(files));
	expect(await prepareCommit(storage, { ...author, timestamp: 2 })).toEqual(
		pending,
	);
	expect((await storage.capture([])).state.remoteBase).toBeNull();
});
