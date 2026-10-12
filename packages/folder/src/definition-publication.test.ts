/**
 * Opening-time definition publication through production Bun and browser adapters.
 * Covers replacement, changed declarations, unchanged history, and
 * best-effort failures while saved rows remain usable.
 */
import { afterEach, expect, test } from 'bun:test';
import { mkdir, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { expectErr, expectOk } from 'wellcrafted/testing';
import {
	defineFolder,
	defineTable,
	type Folder,
	type FolderDefinition,
	field,
} from './contract.js';
import { formatDeclaration } from './declaration.js';
import { events } from './publication-log.test-support.js';

afterEach(() => {
	events.length = 0;
});
const { openFolder: openBun } = await import('./bun.js');
const { openFolder: openBrowser } = await import('./browser.js');

import {
	browserStorage,
	createTestStorage,
} from './browser-storage.test-support.js';
import {
	createBareRemote,
	git,
	gitHttpFetch,
	scratch,
} from './git-http.test-support.js';

const definition = defineFolder({
	title: 'Notes',
	kv: { theme: field.string() },
	tables: { notes: defineTable({ fields: { title: field.string() } }) },
});
const author = { name: 'Publication', email: 'publication@example.test' };
const decode = (bytes: Uint8Array) => new TextDecoder().decode(bytes);

async function settled(folder: Pick<Folder<typeof definition>, 'git'>) {
	for (let attempt = 0; attempt < 500; attempt++) {
		if (!folder.git.snapshot.activity.commit.active) return;
		await Bun.sleep(10);
	}
	throw new Error('Automatic history did not settle');
}

test('opening before downloading an existing browser remote preserves incoming protections', async () => {
	const root = await scratch('definition-existing-remote-');
	await createBareRemote(root);
	const httpFetch = await gitHttpFetch(root);
	// Different authors keep the two opening commits apart even when they
	// land in the same second with the same tree.
	const open = (opener = author) =>
		openBrowser({
			id: 'publication-remote',
			definition,
			browser: {
				author: opener,
				remote: { url: 'http://git.test/remote.git', branch: 'main' },
				httpFetch,
				...browserStorage(createTestStorage()),
			},
		});
	const sender = expectOk(
		await open({ name: 'Sender', email: 'sender@example.test' }),
	);
	try {
		expectOk(await sender.kv.set('theme', 'remote'));
		expect((await sender.git.commitAndPush()).push.status).toBe('pushed');
		const receiver = expectOk(await open());
		try {
			await settled(receiver);
			expectOk(await receiver.git.fetch());
			expect(expectErr(await receiver.git.pullFastForward()).name).toBe(
				'Diverged',
			);
			expect(expectErr(await receiver.git.mergeIncoming()).name).toBe(
				'UnsupportedHistory',
			);
			expect(expectOk(await receiver.kv.get())).toBeUndefined();
		} finally {
			await receiver.close();
		}
	} finally {
		await sender.close();
		await rm(root, { recursive: true, force: true });
	}
});

for (const adapter of ['browser', 'bun'] as const) {
	test(`${adapter}: fresh publication, replacement and changed declarations preserve data`, async () => {
		const root = await scratch('definition-publication-');
		const environment = createTestStorage();
		const open = async <TSchema extends FolderDefinition>(schema: TSchema) =>
			expectOk(
				adapter === 'bun'
					? await openBun({
							root,
							definition: schema,
							git: { author },
						})
					: await openBrowser({
							id: 'publication',
							definition: schema,
							browser: {
								...browserStorage(environment),
								author,
							},
						}),
			);
		let folder = await open(definition);
		try {
			expect(
				decode(expectOk(await folder.files.read('epicenter.json')).bytes),
			).toBe(formatDeclaration(definition));
			expectOk(
				await folder.tables.notes!.create(
					{ fields: { title: 'Saved' }, body: 'Body stays\n' },
					{ stem: 'kept' },
				),
			);
			expectOk(await folder.kv.set('theme', 'dark'));
			const row = expectOk(await folder.files.read('notes/kept.md'));
			const kv = expectOk(await folder.files.read('kv.json'));
			expectOk(
				await folder.files.overwrite(
					'epicenter.json',
					'malformed manual description',
				),
			);
			await folder.close();
			folder = await open(definition);
			expect(
				decode(expectOk(await folder.files.read('epicenter.json')).bytes),
			).toBe(formatDeclaration(definition));
			await folder.close();
			const changed = defineFolder({
				...definition,
				title: 'Changed',
				kv: { theme: field.string({ minLength: 4 }) },
			});
			folder = await open(changed);
			expect(
				decode(expectOk(await folder.files.read('epicenter.json')).bytes),
			).toBe(formatDeclaration(changed));
			expect(expectOk(await folder.files.read('notes/kept.md')).bytes).toEqual(
				row.bytes,
			);
			expect(expectOk(await folder.files.read('kv.json')).bytes).toEqual(
				kv.bytes,
			);
			await settled(folder);
			expect(expectOk(await folder.git.status()).changes).toEqual([]);
		} finally {
			await folder.close();
			await rm(root, { recursive: true, force: true });
		}
	});

	test(`${adapter}: identical reopening writes again without an additional settled commit`, async () => {
		const root = await scratch('definition-history-');
		const environment = createTestStorage();
		const open = async () =>
			expectOk(
				adapter === 'bun'
					? await openBun({ root, definition, git: { author } })
					: await openBrowser({
							id: 'history',
							definition,
							browser: { ...browserStorage(environment), author },
						}),
			);
		let folder = await open();
		try {
			await settled(folder);
			const before = expectOk(await folder.git.log(10));
			expect(before).toHaveLength(1);
			await folder.close();
			folder = await open();
			await settled(folder);
			expect(expectOk(await folder.git.log(10))).toEqual(before);
			expect(folder.git.snapshot.lastCommit?.status).toBe('unchanged');
			if (adapter === 'bun')
				expect(await git(root, 'status', '--porcelain')).toBe('');
		} finally {
			await folder.close();
			await rm(root, { recursive: true, force: true });
		}
	});
}

test('Bun publication failure leaves the folder usable and reports the actual destination failure', async () => {
	const root = await scratch('definition-failure-');
	await mkdir(join(root, 'epicenter.json'));
	const folder = expectOk(await openBun({ root, definition, git: { author } }));
	try {
		expectOk(await folder.files.create('usable.txt', 'usable'));
		expect(
			events.find((event) => event.source === 'folder/definition')?.data,
		).toMatchObject({
			name: 'DefinitionPublicationUnconfirmed',
			path: 'epicenter.json',
			cause: { name: 'NotAFile', path: 'epicenter.json' },
		});
	} finally {
		await folder.close();
		await rm(root, { recursive: true, force: true });
	}
});

test('a definition with a runtime callback is refused before any folder opens, so nothing unpublishable is ever published', () => {
	expect(() =>
		defineFolder({
			kv: {
				// @ts-expect-error The type refuses it too; this is an untyped caller.
				value: {
					type: 'string',
					'~refine': [{ refine: () => true, message: 'local validation' }],
				},
			},
			tables: {},
		}),
	).toThrow('runtime callback');
});
