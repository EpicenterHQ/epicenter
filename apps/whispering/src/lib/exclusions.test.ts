/**
 * App-maintained exclusions over real native and IndexedDB file saves.
 * Startup installs root defaults without overriding authored rules, preserves
 * source bytes, and merges concurrent edits. Native Git and browser commits
 * honor customizations; unreadable content and save failures remain visible.
 */
import 'fake-indexeddb/auto';
import { afterEach, expect, test } from 'bun:test';
import { execFileSync } from 'node:child_process';
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
const rules = ['*', '!*/', '!*.md', '!.gitignore', ''].join('\n');
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
	if (source !== undefined) expectOk(await files.write('.gitignore', source));
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
	const loaded = expectOk(await files.read('.gitignore'));
	return loaded === undefined
		? undefined
		: new TextDecoder('utf-8', { ignoreBOM: true }).decode(
				await loaded.content.arrayBuffer(),
			);
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
	['# another app\n/private/', `${rules}# another app\n/private/`],
	['!*.wav\n', `${rules}!*.wav\n`],
	[
		'\ufeff# café\r\n/cache/',
		`\ufeff${rules.replaceAll('\n', '\r\n')}# café\r\n/cache/`,
	],
])(
	'adds the Markdown-only rules while preserving %j',
	async (before, after) => {
		const { files } = await open(before);
		let supplied: Parameters<FolderFiles['write']>[1] | undefined;
		expectOk(
			await maintainExclusions({
				...files,
				write: async (path, change) => {
					supplied = change;
					return files.write(path, change);
				},
			}),
		);
		expect(supplied).toBe(after);
		const saved = expectOk(await files.read('.gitignore'))!;
		expect(new Uint8Array(await saved.content.arrayBuffer())).toEqual(
			new TextEncoder().encode(after),
		);
	},
);

test.each([
	rules,
	`# keep\n${rules}`,
	`/private/\n${rules}`,
	`${rules}/private/\n!*.wav\n`,
	`${rules}# comment\n\n`,
	`\ufeff${rules.replaceAll('\n', '\r\n')}`,
])('an installed Markdown-only block causes no write: %j', async (before) => {
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

test('startup publishes the complete rules captured before a concurrent edit', async () => {
	const { files } = await open('# keep\n');
	expectOk(
		await maintainExclusions({
			...files,
			write: async (path, change) => {
				expectOk(await files.write(path, '# keep\n/private/\n'));
				return files.write(path, change);
			},
		}),
	);
	expect(await text(files)).toBe(`${rules}# keep\n`);
});

test('a successful save followed by removal of the block reports missing defaults without retrying', async () => {
	const { files } = await open();
	let writes = 0;
	const refused = expectErr(
		await maintainExclusions({
			...files,
			write: async (...args) => {
				writes++;
				const saved = await files.write(...args);
				expectOk(saved);
				expectOk(await files.write('.gitignore', '# concurrent replacement\n'));
				return saved;
			},
		}),
	);
	expect(refused.name).toBe('MissingRules');
	expect(writes).toBe(1);
	expect(await text(files)).toBe('# concurrent replacement\n');
});

test('two browser connections publish whole rule files in completion order', async () => {
	const id = crypto.randomUUID();
	const a = await openRepository(id);
	const b = await openRepository(id);
	cleanups.push(() => {
		a.close();
		b.close();
	});
	expectOk(await a.files.write('.gitignore', '# keep\n'));
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
	expectOk(await b.files.write('.gitignore', '# keep\n/private/\n'));
	expectOk(await maintainExclusions(filesOf(b)));
	release.resolve();
	expectOk(await updating);
	a.close();
	b.close();
	const reopened = await openRepository(id);
	cleanups.push(() => reopened.close());
	expect(await text(reopened.files)).toBe(`${rules}# keep\n`);
});

test('native Git honors root and nested customizations while retaining tracked files and offline bytes', async () => {
	const { files, root } = await open('/private/\nnode_modules/\n');
	const git = (...args: string[]) =>
		execFileSync('git', args, { cwd: root, encoding: 'utf8' });
	git('init', '--quiet');
	expectOk(
		await files.write('recordings/tracked.wav', new Uint8Array([1, 2, 3])),
	);
	git('add', '--', 'recordings/tracked.wav');
	expectOk(await files.write('recordings/new.wav', new Uint8Array([4, 5, 6])));
	expectOk(await files.write('notes/nested/one.md', 'Nested note\n'));
	expectOk(await files.write('private/secret.md', 'Private note\n'));
	expectOk(await files.write('node_modules/pkg/README.md', 'Package\n'));
	expectOk(await files.write('notes/nested/hidden.md', 'Hidden note\n'));
	expectOk(await files.write('notes/nested/.gitignore', '!*.wav\nhidden.md\n'));
	expectOk(await files.write('notes/nested/shared.wav', new Uint8Array([11])));
	expectOk(await files.write('notes/nested/image.png', new Uint8Array([7, 8])));
	expectOk(
		await files.write('notes/nested/export.pdf', new Uint8Array([9, 10])),
	);
	expectOk(await maintainExclusions(files));
	git('add', '--', '.gitignore', 'notes', 'recordings');
	expect(git('ls-files').trim().split('\n')).toEqual([
		'.gitignore',
		'notes/nested/.gitignore',
		'notes/nested/one.md',
		'notes/nested/shared.wav',
		'recordings/tracked.wav',
	]);
	expect(
		git(
			'check-ignore',
			'recordings/new.wav',
			'notes/nested/image.png',
			'notes/nested/export.pdf',
			'private/secret.md',
			'node_modules/pkg/README.md',
			'notes/nested/hidden.md',
		)
			.trim()
			.split('\n'),
	).toEqual([
		'recordings/new.wav',
		'notes/nested/image.png',
		'notes/nested/export.pdf',
		'private/secret.md',
		'node_modules/pkg/README.md',
		'notes/nested/hidden.md',
	]);
	expect(
		new Uint8Array(
			await expectOk(
				await files.read('recordings/new.wav'),
			)!.content.arrayBuffer(),
		),
	).toEqual(new Uint8Array([4, 5, 6]));
});

test('browser Git honors root and nested customizations while preserving offline bytes and an exact pending send', async () => {
	const repository = await openRepository(crypto.randomUUID());
	cleanups.push(() => repository.close());
	const { storage } = repository;
	const files = filesOf(repository);
	const audio = new Uint8Array([0, 255, 1]);
	expectOk(await files.write('.gitignore', '/private/\nnode_modules/\n'));
	expectOk(await files.write('recordings/take.wav', audio));
	expectOk(await files.write('recordings/take.WEBM', audio));
	expectOk(await files.write('recordings/take.md', 'Recording\n'));
	expectOk(
		await files.write('recordings/attachment.pdf', new Uint8Array([1, 2])),
	);
	expectOk(await files.write('notes/one.md', 'Offline note\n'));
	expectOk(await files.write('notes/nested/two.md', 'Nested note\n'));
	expectOk(await files.write('private/secret.md', 'Private note\n'));
	expectOk(await files.write('node_modules/pkg/README.md', 'Package\n'));
	expectOk(await files.write('notes/nested/hidden.md', 'Hidden note\n'));
	expectOk(await files.write('notes/nested/shared.wav', audio));
	expectOk(await files.write('notes/nested/image.png', audio));
	expectOk(await files.write('notes/nested/.gitignore', '!*.wav\nhidden.md\n'));
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
		'notes/nested/.gitignore',
		'notes/nested/shared.wav',
		'notes/nested/two.md',
		'notes/one.md',
		'recordings/take.md',
	]);
	const localAudio = expectOk(await files.read('recordings/take.wav'))!;
	expect(new Uint8Array(await localAudio.content.arrayBuffer())).toEqual(audio);
	expect(
		new Uint8Array(
			await expectOk(
				await files.read('notes/nested/image.png'),
			)!.content.arrayBuffer(),
		),
	).toEqual(audio);
	expectOk(await files.write('.gitignore', '# changed after preparing\n'));
	expectOk(await maintainExclusions(files));
	expect(await prepareCommit(storage, { ...author, timestamp: 2 })).toEqual(
		pending,
	);
	expect((await storage.capture([])).state.remoteBase).toBeNull();
});
