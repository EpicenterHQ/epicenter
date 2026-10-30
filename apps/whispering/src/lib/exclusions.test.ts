/**
 * App-maintained exclusions over real native and IndexedDB folders.
 * Startup installs root defaults without overriding authored rules, preserves
 * source bytes, and publishes whole rule files. Native Git and browser commits
 * honor customizations; unreadable content and save failures remain visible.
 */
import 'fake-indexeddb/auto';
import { afterEach, beforeEach, expect, test } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { readdir } from 'node:fs/promises';
import { openFolder as openBrowserFolder } from '@epicenter/folder/browser';
import { Err } from 'wellcrafted/result';
import { expectErr, expectOk } from 'wellcrafted/testing';
import { readSnapshot } from '../../../../packages/folder/src/browser/git/snapshot.js';
import { openRepository } from '../../../../packages/folder/src/browser/repository.js';
import { prepareCommit } from '../../../../packages/folder/src/browser/sync.js';
import { readCommit } from '../../../../packages/folder/src/git/raw-objects.js';
import { whisperingTables } from './definition.js';
import { maintainExclusions } from './exclusions.js';
import type { WhisperingFolder } from './folder.js';
import { deferred, openTestServices } from './services.test-support.js';

type RuleFiles = Pick<WhisperingFolder, 'read' | 'write'>;

const cleanups: (() => Promise<void> | void)[] = [];
const rules = ['*', '!*/', '!*.md', '!.gitignore', ''].join('\n');
beforeEach(() => {
	globalThis.indexedDB = new IDBFactory();
});
afterEach(async () => {
	for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

async function open(source?: string | Uint8Array) {
	const services = await openTestServices();
	const files = services.folder;
	cleanups.push(services.remove);
	if (source !== undefined) expectOk(await files.write('.gitignore', source));
	return { files, root: services.root };
}

/** This origin's browser folder, as the browser build opens it. */
async function openBrowser() {
	const folder = expectOk(
		await openBrowserFolder({ tables: whisperingTables }),
	);
	cleanups.push(() => folder.close());
	return folder;
}

async function text(files: Pick<RuleFiles, 'read'>) {
	const bytes = expectOk(await files.read('.gitignore'));
	return bytes === null
		? undefined
		: new TextDecoder('utf-8', { ignoreBOM: true }).decode(bytes);
}

/** `files` with each write counted. */
function counting(files: RuleFiles) {
	const counted = {
		writes: 0,
		read: files.read,
		write: ((path, data) => {
			counted.writes++;
			return files.write(path, data);
		}) satisfies RuleFiles['write'],
	};
	return counted;
}

test('an empty folder gets only an ordinary .gitignore, and another startup writes nothing', async () => {
	const { files, root } = await open();
	expectOk(await maintainExclusions(files));
	expect(await text(files)).toBe(rules);
	expect(await readdir(root)).toEqual(['.gitignore']);
	const again = counting(files);
	expectOk(await maintainExclusions(again));
	expect(again.writes).toBe(0);
});

test.each([
	['# another app\n/private/', `${rules}# another app\n/private/`],
	['!*.wav\n', `${rules}!*.wav\n`],
	['﻿# café\r\n/cache/', `﻿${rules.replaceAll('\n', '\r\n')}# café\r\n/cache/`],
])(
	'adds the Markdown-only rules while preserving %j',
	async (before, after) => {
		const { files } = await open(before);
		let supplied: string | Uint8Array | undefined;
		expectOk(
			await maintainExclusions({
				read: files.read,
				write: (path, data) => {
					supplied = data;
					return files.write(path, data);
				},
			}),
		);
		expect(supplied).toBe(after);
		expect(expectOk(await files.read('.gitignore'))).toEqual(
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
	`﻿${rules.replaceAll('\n', '\r\n')}`,
])('an installed Markdown-only block causes no write: %j', async (before) => {
	const { files } = await open(before);
	const counted = counting(files);
	expectOk(await maintainExclusions(counted));
	expect(counted.writes).toBe(0);
});

test.each([new Uint8Array([0xff, 0xfe]), new Uint8Array([97, 0, 98])])(
	'non-text rules stay byte-for-byte intact: %j',
	async (before) => {
		const { files } = await open(before);
		expect(expectErr(await maintainExclusions(files)).name).toBe(
			'InvalidIgnoreText',
		);
		expect(expectOk(await files.read('.gitignore'))).toEqual(before);
	},
);

test('read and save refusals propagate without inventing successful installation', async () => {
	const { files } = await open('# keep\n');
	const readFailure = {
		name: 'StorageFailed',
		message: 'Repository read failed: read refused',
		cause: new Error('read refused'),
	} as const;
	expect(
		expectErr(
			await maintainExclusions({
				read: async () => Err(readFailure),
				write: files.write,
			}),
		),
	).toBe(readFailure);
	const saveFailure = {
		name: 'StorageFailed',
		message: 'Repository save failed: write refused',
		cause: new Error('write refused'),
	} as const;
	expect(
		expectErr(
			await maintainExclusions({
				read: files.read,
				write: async () => Err(saveFailure),
			}),
		),
	).toBe(saveFailure);
	expect(await text(files)).toBe('# keep\n');
});

test('startup publishes the complete rules read before a concurrent edit', async () => {
	const { files } = await open('# keep\n');
	expectOk(
		await maintainExclusions({
			read: files.read,
			write: async (path, data) => {
				expectOk(await files.write(path, '# keep\n/private/\n'));
				return files.write(path, data);
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
			read: files.read,
			write: async (path, data) => {
				writes++;
				const saved = await files.write(path, data);
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

test('two browser tabs publish whole rule files in completion order', async () => {
	const a = await openBrowser();
	const b = await openBrowser();
	expectOk(await a.write('.gitignore', '# keep\n'));
	const begun = deferred<void>();
	const release = deferred<void>();
	const updating = maintainExclusions({
		read: a.read,
		write: async (path, data) => {
			begun.resolve();
			await release.promise;
			return a.write(path, data);
		},
	});
	await begun.promise;
	expectOk(await b.write('.gitignore', '# keep\n/private/\n'));
	expectOk(await maintainExclusions(b));
	release.resolve();
	expectOk(await updating);
	await a.close();
	await b.close();
	const reopened = await openBrowser();
	expect(await text(reopened)).toBe(`${rules}# keep\n`);
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
	expect(expectOk(await files.read('recordings/new.wav'))).toEqual(
		new Uint8Array([4, 5, 6]),
	);
});

test('browser Git honors root and nested customizations while preserving offline bytes and an exact pending send', async () => {
	const files = await openBrowser();
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
	// The browser folder's own repository, where sync prepares its commits.
	const repository = await openRepository('default');
	cleanups.push(() => repository.close());
	const { storage } = repository;
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
	expect(expectOk(await files.read('recordings/take.wav'))).toEqual(audio);
	expect(expectOk(await files.read('notes/nested/image.png'))).toEqual(audio);
	expectOk(await files.write('.gitignore', '# changed after preparing\n'));
	expectOk(await maintainExclusions(files));
	expect(await prepareCommit(storage, { ...author, timestamp: 2 })).toEqual(
		pending,
	);
	expect((await storage.capture([])).state.remoteBase).toBeNull();
});
