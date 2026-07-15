/**
 * Sign-in migration tests.
 *
 * Verifies the shared first-sign-in migration contract: local rows trigger
 * the prompt, Add copies rows then clears the bare root, child docs are
 * derived from the source table schema, and crash-safety ordering preserves
 * retryable local data at the failure boundaries.
 *
 * Key behaviors:
 * - Probe opens only for signed-in boots with staged local rows
 * - Add derives, merges, and cleans up child docs without app-supplied readers
 * - Delete clears derived child docs before the root
 * - Table subsets exclude rows and child docs together
 */

import { expect, mock, test } from 'bun:test';
import { type AuthClient, type AuthState } from '@epicenter/auth';
import { field } from '@epicenter/field';
import { asPrincipalId } from '@epicenter/identity';
import {
	attachIndexedDb,
	attachLocalStorage,
	defineTable,
	defineWorkspace,
} from '@epicenter/workspace';
import { IDBKeyRange, indexedDB } from 'fake-indexeddb';
import { Ok } from 'wellcrafted/result';
import * as Y from 'yjs';

mock.module('@epicenter/ui/sonner', () => ({
	toastOnError: <T>(value: T) => value,
}));

const { createSignInMigration } = await import(
	'./create-sign-in-migration.svelte.js'
);

(globalThis as unknown as { $state: <T>(value: T) => T }).$state = (value) =>
	value;
Object.assign(globalThis, { indexedDB, IDBKeyRange });

class FakeBroadcastChannel {
	onmessage: ((event: MessageEvent) => void) | null = null;
	constructor(readonly name: string) {}
	postMessage(_message: unknown): void {}
	close(): void {}
}
Object.assign(globalThis, { BroadcastChannel: FakeBroadcastChannel });

const SERVER = 'api.test';
const PRINCIPAL_ID = asPrincipalId('owner-1');
const principalScope = { server: SERVER, principalId: PRINCIPAL_ID };

const notes = defineTable({
	id: field.string(),
	title: field.string(),
}).docs({ body: (ydoc: Y.Doc) => ({ text: ydoc.getText('body') }) });

const folders = defineTable({
	id: field.string(),
	title: field.string(),
});

const conversations = defineTable({
	id: field.string(),
	title: field.string(),
}).docs({ messages: (ydoc: Y.Doc) => ({ text: ydoc.getText('messages') }) });

const model = defineWorkspace({
	id: `sign-in-migration-${crypto.randomUUID()}`,
	name: 'Sign-in Migration Test',
	tables: { notes, folders, conversations },
	kv: {},
});

const rowsOnlyModel = defineWorkspace({
	id: `sign-in-migration-rows-${crypto.randomUUID()}`,
	name: 'Rows-only Migration Test',
	tables: { folders },
	kv: {},
});

function tick(): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, 0));
}

function createAuth(
	overrides: { state?: AuthState; baseURL?: string } = {},
): AuthClient {
	return {
		state: overrides.state ?? {
			status: 'signed-in',
			principalId: PRINCIPAL_ID,
		},
		deployment: {
			kind: 'hosted',
			baseURL: overrides.baseURL ?? `https://${SERVER}`,
		},
		onStateChange: () => () => {},
		startSignIn: async () => Ok(undefined),
		signOut: async () => Ok(undefined),
		fetch: async () => new Response(null, { status: 204 }),
		getProfile: async () =>
			Ok({ id: asPrincipalId('user-1'), email: 'user@example.com' }),
		[Symbol.dispose]() {},
	};
}

function openLocalSource(
	subset: (
		tables: ReturnType<typeof model.create>['tables'],
	) => Partial<ReturnType<typeof model.create>['tables']> = (tables) => tables,
) {
	const workspace = model.create();
	const idb = attachIndexedDb(workspace.ydoc);
	return {
		tables: subset(workspace.tables),
		whenLoaded: idb.whenLoaded,
		clearLocal: idb.clearLocal,
		dispose: () => workspace.ydoc.destroy(),
	};
}

function openRowsOnlyLocalSource() {
	const workspace = rowsOnlyModel.create();
	const idb = attachIndexedDb(workspace.ydoc);
	return {
		tables: workspace.tables,
		whenLoaded: idb.whenLoaded,
		clearLocal: idb.clearLocal,
		dispose: () => workspace.ydoc.destroy(),
	};
}

function setup() {
	const target = model.create();
	const migration = createSignInMigration({
		auth: createAuth(),
		openLocalSource,
		target: {
			whenReady: Promise.resolve(),
			ydoc: target.ydoc,
			tables: target.tables,
		},
		describe: (counts) => `${counts.notes ?? 0} notes`,
		errorNoun: 'notes',
	});
	return { migration, target };
}

async function seedBareLocal(options: {
	note?: { id: string; title: string; body?: string };
	folder?: { id: string; title: string };
	conversation?: { id: string; title: string; messages?: string };
}) {
	const oldBundle = model.connect({ kind: 'local' });
	await oldBundle.storage.whenLoaded;
	await oldBundle.wipe();

	const bundle = model.connect({ kind: 'local' });
	await bundle.storage.whenLoaded;

	if (options.note) {
		bundle.tables.notes.set({
			id: options.note.id,
			title: options.note.title,
		});
		if (options.note.body !== undefined) {
			const body = bundle.tables.notes.docs.body.open(options.note.id);
			await body.whenLoaded;
			body.text.insert(0, options.note.body);
			body[Symbol.dispose]();
		}
	}
	if (options.folder) {
		bundle.tables.folders.set({
			id: options.folder.id,
			title: options.folder.title,
		});
	}
	if (options.conversation) {
		bundle.tables.conversations.set({
			id: options.conversation.id,
			title: options.conversation.title,
		});
		if (options.conversation.messages !== undefined) {
			const messages = bundle.tables.conversations.docs.messages.open(
				options.conversation.id,
			);
			await messages.whenLoaded;
			messages.text.insert(0, options.conversation.messages);
			messages[Symbol.dispose]();
		}
	}

	await tick();
	bundle[Symbol.dispose]();
	await bundle.storage.whenDisposed;
}

async function seedRowsOnlyLocal(row: { id: string; title: string }) {
	const oldBundle = rowsOnlyModel.connect({ kind: 'local' });
	await oldBundle.storage.whenLoaded;
	await oldBundle.wipe();

	const bundle = rowsOnlyModel.connect({ kind: 'local' });
	await bundle.storage.whenLoaded;
	bundle.tables.folders.set(row);
	await tick();
	bundle[Symbol.dispose]();
	await bundle.storage.whenDisposed;
}

async function readBareText(guid: string, textName: string): Promise<string> {
	const ydoc = new Y.Doc({ guid, gc: true });
	const idb = attachIndexedDb(ydoc);
	await idb.whenLoaded;
	const text = ydoc.getText(textName).toString();
	ydoc.destroy();
	await idb.whenDisposed;
	return text;
}

async function readPrincipalText(
	guid: string,
	textName: string,
): Promise<string> {
	const ydoc = new Y.Doc({ guid, gc: true });
	const idb = attachLocalStorage(ydoc, principalScope);
	await idb.whenLoaded;
	const text = ydoc.getText(textName).toString();
	ydoc.destroy();
	await idb.whenDisposed;
	return text;
}

async function readBareRows() {
	const source = openLocalSource();
	try {
		await source.whenLoaded;
		return {
			notes: source.tables.notes!.scan().rows,
			folders: source.tables.folders!.scan().rows,
			conversations: source.tables.conversations!.scan().rows,
		};
	} finally {
		source.dispose();
	}
}

test('check() opens the dialog for signed-in boots with staged local rows', async () => {
	await seedBareLocal({ note: { id: 'probe-note', title: 'Probe' } });
	const { migration } = setup();

	await migration.check();

	expect(migration.open).toBe(true);
	expect(migration.summary).toBe('1 notes');
});

test('addToAccount() copies rows idempotently and clears the bare root', async () => {
	await seedBareLocal({
		note: { id: 'copy-note', title: 'Copy me' },
		folder: { id: 'copy-folder', title: 'Folder' },
	});
	const { migration, target } = setup();

	await migration.addToAccount();
	await migration.addToAccount();

	expect(target.tables.notes.scan().rows).toEqual([
		{ id: 'copy-note', title: 'Copy me' },
	]);
	expect(target.tables.folders.scan().rows).toEqual([
		{ id: 'copy-folder', title: 'Folder' },
	]);
	expect(await readBareRows()).toEqual({
		notes: [],
		folders: [],
		conversations: [],
	});
});

test('addToAccount() derives child docs, merges them before row copy, and keeps the root retryable on copy failure', async () => {
	await seedBareLocal({
		note: { id: 'failing-note', title: 'Will fail', body: 'principal copy' },
	});
	const source = openLocalSource();
	await source.whenLoaded;
	const childGuid = source.tables.notes!.docs.body.guid('failing-note');
	source.dispose();

	const migration = createSignInMigration({
		auth: createAuth(),
		openLocalSource,
		target: {
			whenReady: Promise.resolve(),
			ydoc: new Y.Doc({ guid: 'failing-target' }),
			tables: {
				notes: {
					set: () => ({ error: new Error('copy failed') }),
				},
				folders: {
					set: () => ({ error: null }),
				},
				conversations: {
					set: () => ({ error: null }),
				},
			},
		},
		describe: () => 'data',
	});

	await migration.addToAccount();

	expect(await readPrincipalText(childGuid, 'body')).toBe('principal copy');
	expect((await readBareRows()).notes).toEqual([
		{ id: 'failing-note', title: 'Will fail' },
	]);
	expect(await readBareText(childGuid, 'body')).toBe('principal copy');
});

test('addToAccount() deletes bare child docs after a successful row copy', async () => {
	await seedBareLocal({
		note: { id: 'cleanup-note', title: 'Cleanup', body: 'remove bare copy' },
	});
	const source = openLocalSource();
	await source.whenLoaded;
	const childGuid = source.tables.notes!.docs.body.guid('cleanup-note');
	source.dispose();
	const { migration } = setup();

	await migration.addToAccount();

	expect(await readPrincipalText(childGuid, 'body')).toBe('remove bare copy');
	expect(await readBareText(childGuid, 'body')).toBe('');
});

test('deleteFromDevice() clears derived child docs before clearing the root', async () => {
	await seedBareLocal({
		note: { id: 'delete-note', title: 'Delete', body: 'remove first' },
	});
	const source = openLocalSource();
	await source.whenLoaded;
	const childGuid = source.tables.notes!.docs.body.guid('delete-note');
	source.dispose();

	const migration = createSignInMigration({
		auth: createAuth(),
		openLocalSource: () => {
			const opened = openLocalSource();
			return {
				...opened,
				clearLocal: async () => {
					throw new Error('root clear failed');
				},
			};
		},
		target: {
			whenReady: Promise.resolve(),
			ydoc: new Y.Doc({ guid: 'delete-target' }),
			tables: {
				notes: { set: () => ({ error: null }) },
				folders: { set: () => ({ error: null }) },
				conversations: { set: () => ({ error: null }) },
			},
		},
		describe: () => 'data',
	});

	await migration.deleteFromDevice();

	expect(await readBareText(childGuid, 'body')).toBe('');
	expect((await readBareRows()).notes).toEqual([
		{ id: 'delete-note', title: 'Delete' },
	]);
});

test('a local-source table subset excludes rows and child docs together', async () => {
	await seedBareLocal({
		note: { id: 'included-note', title: 'Included', body: 'moves' },
		conversation: {
			id: 'excluded-conversation',
			title: 'Excluded',
			messages: 'stays bare only',
		},
	});
	const source = openLocalSource();
	await source.whenLoaded;
	const includedGuid = source.tables.notes!.docs.body.guid('included-note');
	const excludedGuid = source.tables.conversations!.docs.messages.guid(
		'excluded-conversation',
	);
	source.dispose();

	const target = model.create();
	const migration = createSignInMigration({
		auth: createAuth(),
		openLocalSource: () =>
			openLocalSource((tables) => ({ notes: tables.notes })),
		target: {
			whenReady: Promise.resolve(),
			ydoc: target.ydoc,
			tables: { notes: target.tables.notes },
		},
		describe: () => 'notes',
	});

	await migration.addToAccount();

	expect(target.tables.notes.scan().rows).toEqual([
		{ id: 'included-note', title: 'Included' },
	]);
	expect(await readPrincipalText(includedGuid, 'body')).toBe('moves');
	expect(await readPrincipalText(excludedGuid, 'messages')).toBe('');
	// The excluded child's bare copy must survive: cleanup only iterates the
	// derived (included) guids, never data the app chose to leave out.
	expect(await readBareText(excludedGuid, 'messages')).toBe('stays bare only');
	expect(await readBareRows()).toEqual({
		notes: [],
		folders: [],
		conversations: [],
	});
});

test('a rows-only workspace derives no child docs and never reads principal scope', async () => {
	await seedRowsOnlyLocal({ id: 'rows-only', title: 'Rows only' });
	const target = rowsOnlyModel.create();
	const migration = createSignInMigration({
		auth: createAuth({ baseURL: 'not a url' }),
		openLocalSource: openRowsOnlyLocalSource,
		target: {
			whenReady: Promise.resolve(),
			ydoc: target.ydoc,
			tables: target.tables,
		},
		describe: () => 'folders',
	});

	await migration.addToAccount();

	expect(target.tables.folders.scan().rows).toEqual([
		{ id: 'rows-only', title: 'Rows only' },
	]);
});
