/**
 * Workspace construction tests: low-level root docs via `createWorkspace`, and
 * app-facing definitions via `defineWorkspace(...).connect(...)`.
 */

import { describe, expect, test } from 'bun:test';
import { field, InstantString } from '@epicenter/field';
import { asPrincipalId } from '@epicenter/identity';
import { IDBKeyRange, indexedDB } from 'fake-indexeddb';
import { Type } from 'typebox';
import * as Y from 'yjs';
import { defineActions, defineQuery } from '../shared/actions.js';
import type { WorkspaceConnection } from '../workspace-connection.js';
import { attachPlainText } from './attach-plain-text.js';
import { defineKv } from './define-kv.js';
import { defineTable } from './define-table.js';
import {
	createWorkspace,
	defineWorkspace,
	type LocalPersistence,
} from './workspace.js';

Object.assign(globalThis, { indexedDB, IDBKeyRange });

function fakeWebSocket(): Promise<WebSocket> {
	const ws = {
		readyState: 0,
		onclose: null as ((e: CloseEvent) => void) | null,
		close() {
			if (ws.readyState === 3) return;
			ws.readyState = 3;
			ws.onclose?.({ code: 1000, reason: '' } as CloseEvent);
		},
	};
	return Promise.resolve(ws as unknown as WebSocket);
}

const connection: WorkspaceConnection = {
	kind: 'server',
	baseURL: 'https://api.test.invalid',
	principalId: asPrincipalId('principal-1'),
	fetch,
	openWebSocket: fakeWebSocket,
	onReconnectSignal: () => () => {},
};

const notesDefinition = defineTable({
	id: field.string(),
	title: field.string(),
});

const sortOrderDefinition = defineKv(
	Type.Enum(['asc', 'desc']),
	() => 'asc' as const,
);

describe('createWorkspace', () => {
	test('plaintext construction reads and writes', () => {
		const workspace = createWorkspace({
			id: 'ws-plain',
			tables: { notes: notesDefinition },
			kv: { sortOrder: sortOrderDefinition },
		});

		workspace.tables.notes.set({ id: '1', title: 'hello' });
		expect(workspace.tables.notes.get('1').data).toEqual({
			id: '1',
			title: 'hello',
		});

		expect(workspace.kv.get('sortOrder')).toBe('asc');
		workspace.kv.set('sortOrder', 'desc');
		expect(workspace.kv.get('sortOrder')).toBe('desc');

		workspace[Symbol.dispose]();
	});

	test('workspace.ydoc.guid equals options.id', () => {
		const workspace = createWorkspace({
			id: 'ws-identity',
			tables: {},
			kv: {},
		});
		expect(workspace.ydoc.guid).toBe('ws-identity');
		workspace[Symbol.dispose]();
	});

	test('using-disposal destroys the underlying ydoc', () => {
		let destroyed = false;
		{
			using workspace = createWorkspace({
				id: 'ws-using',
				tables: { notes: notesDefinition },
				kv: {},
			});
			workspace.ydoc.once('destroy', () => {
				destroyed = true;
			});
		}
		expect(destroyed).toBe(true);
	});

	test('empty tables and empty kv are coherent', () => {
		const workspace = createWorkspace({
			id: 'ws-empty',
			tables: {},
			kv: {},
		});
		expect(workspace.ydoc.guid).toBe('ws-empty');
		expect(Object.keys(workspace.tables)).toEqual([]);
		workspace[Symbol.dispose]();
	});
});

describe('defineWorkspace', () => {
	test('create() builds an unconnected root workspace', () => {
		using workspace = defineWorkspace({
			id: 'ws-definition-local',
			name: 'ws-definition-local',
			tables: { notes: notesDefinition },
			kv: { sortOrder: sortOrderDefinition },
		}).create();

		workspace.tables.notes.set({ id: '1', title: 'hello' });
		expect(workspace.tables.notes.get('1').data?.title).toBe('hello');
		expect(workspace.kv.get('sortOrder')).toBe('asc');
	});

	test('open(connection) wires root sync and row child-doc handles', async () => {
		const workspaceDefinition = defineWorkspace({
			id: 'ws-definition-connected',
			name: 'ws-definition-connected',
			tables: {
				notes: notesDefinition.docs({ body: attachPlainText }),
			},
			kv: {},
		});

		const workspace = workspaceDefinition.connect(connection);
		const body = workspace.tables.notes.docs.body.open('note-1');
		try {
			body.write('body text');
			expect(body.read()).toBe('body text');
			expect(String(body.guid)).toBe(
				'ws-definition-connected.notes.note-1.body',
			);
			await Promise.all([workspace.storage.whenLoaded, body.whenLoaded]);
		} finally {
			body[Symbol.dispose]();
			workspace[Symbol.dispose]();
		}
	});

	test('open(connection) namespaces child docs under .docs so field names never collide', () => {
		// `set` would collide with `table.set` if openers were spread flat; under
		// `.docs` it is just another field name. The guid still derives from the
		// field, and the row CRUD method is untouched.
		const workspaceDefinition = defineWorkspace({
			id: 'ws-definition-docs-namespace',
			name: 'ws-definition-docs-namespace',
			tables: {
				notes: notesDefinition.docs({ set: attachPlainText }),
			},
			kv: {},
		});

		const workspace = workspaceDefinition.connect(connection);
		try {
			expect(typeof workspace.tables.notes.set).toBe('function');
			using body = workspace.tables.notes.docs.set.open('note-1');
			expect(String(body.guid)).toBe(
				'ws-definition-docs-namespace.notes.note-1.set',
			);
		} finally {
			workspace[Symbol.dispose]();
		}
	});

	test('open(connection) child docs dedup by rowId: same rowId shares one Y.Doc', () => {
		const workspace = defineWorkspace({
			id: 'ws-childdoc-dedup',
			name: 'ws-childdoc-dedup',
			tables: { notes: notesDefinition.docs({ body: attachPlainText }) },
			kv: {},
		}).connect(connection);
		const a = workspace.tables.notes.docs.body.open('note-1');
		const b = workspace.tables.notes.docs.body.open('note-1');
		try {
			// Distinct handles...
			expect(a).not.toBe(b);
			// ...over one shared doc: a write through `a` is visible through `b`.
			a.write('shared');
			expect(b.read()).toBe('shared');
		} finally {
			a[Symbol.dispose]();
			b[Symbol.dispose]();
			workspace[Symbol.dispose]();
		}
	});

	test('open(connection) child docs refcount: one holder disposing keeps the doc alive for the other', () => {
		const workspace = defineWorkspace({
			id: 'ws-childdoc-refcount',
			name: 'ws-childdoc-refcount',
			tables: { notes: notesDefinition.docs({ body: attachPlainText }) },
			kv: {},
		}).connect(connection);
		try {
			const a = workspace.tables.notes.docs.body.open('note-1');
			a.write('persisted');
			const b = workspace.tables.notes.docs.body.open('note-1');

			// First dispose drops the refcount to 1; the shared doc stays alive, so
			// `b` still reads the write. (gcTime teardown is the cache's own concern,
			// covered in `disposable-cache.test.ts`.)
			a[Symbol.dispose]();
			expect(b.read()).toBe('persisted');

			b[Symbol.dispose]();
		} finally {
			workspace[Symbol.dispose]();
		}
	});

	test('open(connection) child docs are independent across rowIds', () => {
		const workspace = defineWorkspace({
			id: 'ws-childdoc-independent',
			name: 'ws-childdoc-independent',
			tables: { notes: notesDefinition.docs({ body: attachPlainText }) },
			kv: {},
		}).connect(connection);
		const one = workspace.tables.notes.docs.body.open('note-1');
		const two = workspace.tables.notes.docs.body.open('note-2');
		try {
			one.write('first');
			expect(two.read()).toBe('');
			expect(String(one.guid)).not.toBe(String(two.guid));
		} finally {
			one[Symbol.dispose]();
			two[Symbol.dispose]();
			workspace[Symbol.dispose]();
		}
	});

	test('wipe waits for open child-doc storage before deleting local data', async () => {
		let wipeCalled = false;
		const childDisposed = Promise.withResolvers<void>();
		const persistence: LocalPersistence = {
			attach(ydoc) {
				if (ydoc.guid === 'ws-wipe-child-storage') {
					const rootDisposed = Promise.withResolvers<void>();
					ydoc.once('destroy', () => rootDisposed.resolve());
					return {
						whenLoaded: Promise.resolve(),
						whenDisposed: rootDisposed.promise,
					};
				}

				return {
					whenLoaded: Promise.resolve(),
					whenDisposed: childDisposed.promise,
				};
			},
			async wipe() {
				wipeCalled = true;
			},
		};
		const workspace = defineWorkspace({
			id: 'ws-wipe-child-storage',
			name: 'ws-wipe-child-storage',
			tables: { notes: notesDefinition.docs({ body: attachPlainText }) },
			kv: {},
		}).connect({ kind: 'local' }, { persistence });

		workspace.tables.notes.docs.body.open('note-1');
		const wipe = workspace.wipe();

		await Promise.resolve();
		expect(wipeCalled).toBe(false);

		childDisposed.resolve();
		await wipe;
		expect(wipeCalled).toBe(true);
	});

	test('docs touch stamps the row on local edits, not on synced ones', () => {
		const recencyNotes = defineTable({
			id: field.string(),
			title: field.string(),
			updatedAt: field.instant(),
		}).docs({
			body: {
				layout: attachPlainText,
				touch: 'updatedAt',
			},
		});

		const workspace = defineWorkspace({
			id: 'ws-touch-on-edit',
			name: 'ws-touch-on-edit',
			tables: { notes: recencyNotes },
			kv: {},
		}).connect(connection);

		// A fixed past instant: `InstantString.now()` is always strictly greater,
		// so the assertions hold regardless of wall-clock resolution.
		const PAST = '2000-01-01T00:00:00.000Z' as InstantString;

		try {
			workspace.tables.notes.set({
				id: 'note-1',
				title: 't',
				updatedAt: PAST,
			});
			using body = workspace.tables.notes.docs.body.open('note-1');

			// A local edit touches the recency column to a fresh canonical instant.
			body.write('hello');
			const bumped = workspace.tables.notes.get('note-1').data?.updatedAt;
			expect(bumped).not.toBe(PAST);
			expect(InstantString.is(bumped)).toBe(true);

			// A synced update (`tx.local === false`) must NOT touch the column: reset
			// it, apply a remote update to the body doc, and confirm the row is left
			// untouched.
			workspace.tables.notes.update('note-1', { updatedAt: PAST });
			const remote = new Y.Doc();
			remote.getText('content').insert(0, 'from another node');
			Y.applyUpdate(body.ydoc, Y.encodeStateAsUpdate(remote));
			expect(body.read()).toContain('from another node');
			expect(workspace.tables.notes.get('note-1').data?.updatedAt).toBe(PAST);
		} finally {
			workspace[Symbol.dispose]();
		}
	});

	test('open(connection, compose) exposes runtime actions and disposes runtime extras', () => {
		let runtimeDisposed = false;
		const workspace = defineWorkspace({
			id: 'ws-definition-runtime',
			name: 'ws-definition-runtime',
			tables: { notes: notesDefinition },
			kv: {},
		}).connect(connection, ({ tables, actions }) => ({
			runtimeLabel: 'browser-only',
			actions: defineActions({
				...actions,
				notes_count: defineQuery({
					description: 'Count notes.',
					handler: () => tables.notes.storedCount(),
				}),
			}),
			[Symbol.dispose]() {
				runtimeDisposed = true;
			},
		}));

		workspace.tables.notes.set({ id: '1', title: 'hello' });
		expect(workspace.runtimeLabel).toBe('browser-only');
		if (!workspace.collaboration) throw new Error('expected relay wiring');
		expect(workspace.actions.notes_count()).toBe(1);
		workspace[Symbol.dispose]();
		expect(runtimeDisposed).toBe(true);
	});
});
