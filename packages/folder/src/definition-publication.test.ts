/**
 * Definition publication through production Bun and browser adapters: a
 * handle publishes `epicenter.json` just before its first write, never on
 * open. Covers a folder nobody wrote to, replacement, changed declarations,
 * an unchanged declaration left unwritten, unchanged history, and best-effort
 * failures while saved rows remain usable.
 */
import { afterEach, expect, test } from 'bun:test';
import { mkdir, rm, stat } from 'node:fs/promises';
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
import { put } from './put.test-support.js';

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

test('opening writes nothing, so a fresh browser copy takes an existing remote as it is', async () => {
	const root = await scratch('definition-existing-remote-');
	await createBareRemote(root);
	const httpFetch = await gitHttpFetch(root);
	const url = 'http://git.test/remote.git';
	const open = (environment = createTestStorage()) =>
		openBrowser({
			id: 'publication-remote',
			definition,
			browser: { author, httpFetch, ...browserStorage(environment) },
		});
	const sender = expectOk(await open());
	try {
		expectOk(await sender.kv.set('theme', 'remote'));
		expect(expectOk(await sender.sync.connect(url)).kind).toBe('synced');
		const environment = createTestStorage();
		const receiver = expectOk(await open(environment));
		try {
			expect(environment.opfs.directories()).toEqual([]);
			expect(expectOk(await receiver.files.list()).files).toEqual([]);
			expect(expectOk(await receiver.sync.connect(url)).kind).toBe('synced');
			expect(expectOk(await receiver.kv.get())).toMatchObject({
				values: { theme: 'remote' },
			});
			expect(
				decode(expectOk(await receiver.files.read('epicenter.json')).bytes),
			).toBe(formatDeclaration(definition));
			expect(expectOk(await receiver.git.status()).changes).toEqual([]);
		} finally {
			await receiver.close();
		}
	} finally {
		await sender.close();
		await rm(root, { recursive: true, force: true });
	}
});

for (const adapter of ['browser', 'bun'] as const) {
	test(`${adapter}: the first write publishes the declaration, and each later handle's first write replaces it, preserving data in manual history`, async () => {
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
		const declaration = async (folder: {
			files: Folder<typeof definition>['files'];
		}) => decode(expectOk(await folder.files.read('epicenter.json')).bytes);
		let folder: Folder<FolderDefinition> = await open(definition);
		try {
			expect(expectErr(await folder.files.read('epicenter.json')).name).toBe(
				'NotFound',
			);
			expectOk(
				await folder.tables.notes!.create(
					{ fields: { title: 'Saved' }, body: 'Body stays\n' },
					{ stem: 'kept' },
				),
			);
			expect(await declaration(folder)).toBe(formatDeclaration(definition));
			expectOk(await folder.kv.set('theme', 'dark'));
			const row = expectOk(await folder.files.read('notes/kept.md'));
			const kv = expectOk(await folder.files.read('kv.json'));
			expectOk(
				await put(
					folder.files,
					'epicenter.json',
					'malformed manual description',
				),
			);
			await folder.close();
			// Reopening writes nothing; the next write publishes again.
			folder = await open(definition);
			expect(await declaration(folder)).toBe('malformed manual description');
			expectOk(await folder.kv.set('theme', 'dark'));
			expect(await declaration(folder)).toBe(formatDeclaration(definition));
			await folder.close();
			const changed = defineFolder({
				...definition,
				title: 'Changed',
				kv: { theme: field.string({ minLength: 4 }) },
			});
			folder = await open(changed);
			expectOk(await folder.kv.set('theme', 'dark'));
			expect(await declaration(folder)).toBe(formatDeclaration(changed));
			expect(expectOk(await folder.files.read('notes/kept.md')).bytes).toEqual(
				row.bytes,
			);
			expect(expectOk(await folder.files.read('kv.json')).bytes).toEqual(
				kv.bytes,
			);
			expect(expectOk(await folder.git.log(10))).toEqual([]);
			expect(folder.git.snapshot.activity.commit.active).toBe(false);
		} finally {
			await folder.close();
			await rm(root, { recursive: true, force: true });
		}
	});

	test(`${adapter}: a later handle's first write leaves an unchanged declaration unwritten and rewrites a changed one`, async () => {
		const root = await scratch('definition-unchanged-');
		// Pages of one origin tell each other the paths they write, so a
		// second browser handle hears what the first one wrote.
		const environment = createTestStorage({ BroadcastChannel });
		const open = async <TSchema extends FolderDefinition>(schema: TSchema) =>
			expectOk(
				adapter === 'bun'
					? await openBun({ root, definition: schema, git: { author } })
					: await openBrowser({
							id: 'unchanged',
							definition: schema,
							browser: { ...browserStorage(environment), author },
						}),
			);
		const watched = ['epicenter.json', 'kv.json'];
		/** Which files the saves in `write` replaced. */
		const landed = async (
			_folder: Folder<FolderDefinition>,
			write: () => Promise<unknown>,
		) => {
			if (adapter === 'bun') {
				// Each save renames a new file into place.
				const inode = (path: string) =>
					stat(join(root, path)).then(
						(found) => found.ino,
						() => undefined,
					);
				const before = await Promise.all(watched.map(inode));
				await write();
				const after = await Promise.all(watched.map(inode));
				return watched.filter((_, index) => before[index] !== after[index]);
			}
			const listener = await open(definition);
			const paths = new Set<string>();
			listener.onFilesChanged((changed) => {
				if (changed !== 'everything')
					for (const path of changed) paths.add(path);
			});
			await write();
			for (let tries = 0; tries < 20; tries++) await Bun.sleep(5);
			await listener.close();
			return watched.filter((path) => paths.has(path));
		};
		let folder: Folder<FolderDefinition> = await open(definition);
		try {
			expect(
				await landed(folder, async () =>
					expectOk(await folder.kv.set('theme', 'dark')),
				),
			).toEqual(['epicenter.json', 'kv.json']);
			await folder.close();
			folder = await open(definition);
			expect(
				await landed(folder, async () =>
					expectOk(await folder.kv.set('theme', 'light')),
				),
			).toEqual(['kv.json']);
			await folder.close();
			const changed = defineFolder({ ...definition, title: 'Changed' });
			folder = await open(changed);
			expect(
				await landed(folder, async () =>
					expectOk(await folder.kv.set('theme', 'dark')),
				),
			).toEqual(['epicenter.json', 'kv.json']);
			expect(
				decode(expectOk(await folder.files.read('epicenter.json')).bytes),
			).toBe(formatDeclaration(changed));
		} finally {
			await folder.close();
			await rm(root, { recursive: true, force: true });
		}
	});

	test(`${adapter}: an identical declaration written again leaves nothing to commit`, async () => {
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
			expectOk(await folder.kv.set('theme', 'dark'));
			expect((await folder.git.commit()).status).toBe('committed');
			const before = expectOk(await folder.git.log(10));
			expect(before).toHaveLength(1);
			await folder.close();
			folder = await open();
			expectOk(await folder.kv.set('theme', 'dark'));
			expect(folder.git.snapshot.lastCommit).toBeUndefined();
			expect(expectOk(await folder.git.status()).changes).toEqual([]);
			expect((await folder.git.commit()).status).toBe('unchanged');
			expect(expectOk(await folder.git.log(10))).toEqual(before);
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
