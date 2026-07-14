/**
 * Browser Workspace Document Runtime Tests
 *
 * Proves that the production browser owner hydrates KV before defaults are
 * visible, persists child documents, and shares one refcounted room per guid.
 */

import { expect, test } from 'bun:test';
import { asPrincipalId } from '@epicenter/identity';
import { IDBKeyRange, indexedDB } from 'fake-indexeddb';
import type { Guid } from '../shared/id.js';
import {
	browserWorkspaceDocumentDatabaseName,
	createBrowserWorkspaceDocumentPlanes,
} from './browser-document-runtime.js';
import type { WorkspaceServiceResponse } from './client.js';
import { defineKv, defineTable } from './definition.js';
import { document } from './document-format.js';
import { field } from './field.js';
import {
	type OwnedWorkspaceServicePort,
	openWorkspaceFromService,
} from './open.js';
import { defineTestWorkspace } from './test-workspace.js';

Object.assign(globalThis, { indexedDB, IDBKeyRange });

function createService(
	definition: ReturnType<typeof createDefinition>,
): OwnedWorkspaceServicePort {
	return {
		async request(): Promise<WorkspaceServiceResponse> {
			return {
				kind: 'workspace',
				workspaceKind: 'standalone',
				workspaceId: definition.workspaceId,
				recordsDescriptor: definition.recordsDescriptor,
				recordsSchemaHash: definition.recordsSchemaHash,
			};
		},
		observe() {
			return () => undefined;
		},
		async [Symbol.asyncDispose]() {},
	};
}

function createDefinition() {
	return defineTestWorkspace({
		appId: `browser-documents-${crypto.randomUUID()}`,
		tables: {
			notes: defineTable({
				fields: {
					id: field.id(),
					body: field.doc(document.plainText),
				},
			}),
		},
		kv: { theme: defineKv(field.string(), () => 'light') },
	});
}

test('KV and child documents hydrate from the authority-owned local stores', async () => {
	const definition = createDefinition();
	const firstPlanes = await createBrowserWorkspaceDocumentPlanes(definition, {
		authority: { kind: 'local' },
		documentGcTime: 0,
	});
	const first = await openWorkspaceFromService(definition, {
		service: createService(definition),
		expectedKind: 'standalone',
		kv: firstPlanes.kv,
		documents: firstPlanes.documents,
	});

	first.kv.set('theme', 'dark');
	const firstBody = first.tables.notes.docs.body.open('note-1');
	await firstBody.whenReady;
	firstBody.content.write('persisted body');
	firstBody[Symbol.dispose]();
	await first[Symbol.asyncDispose]();
	await firstPlanes[Symbol.asyncDispose]();

	const secondPlanes = await createBrowserWorkspaceDocumentPlanes(definition, {
		authority: { kind: 'local' },
		documentGcTime: 0,
	});
	const second = await openWorkspaceFromService(definition, {
		service: createService(definition),
		expectedKind: 'standalone',
		kv: secondPlanes.kv,
		documents: secondPlanes.documents,
	});

	expect(second.kv.get('theme')).toBe('dark');
	const secondBody = second.tables.notes.docs.body.open('note-1');
	await secondBody.whenReady;
	expect(secondBody.content.read()).toBe('persisted body');
	secondBody[Symbol.dispose]();
	await second[Symbol.asyncDispose]();
	await secondPlanes[Symbol.asyncDispose]();
});

test('child rooms share one document until the last session is released', async () => {
	const definition = createDefinition();
	const planes = await createBrowserWorkspaceDocumentPlanes(definition, {
		authority: { kind: 'local' },
		documentGcTime: 0,
	});
	const guid = `${definition.workspaceId}.shared-room` as Guid;
	const first = planes.documents.open(guid);
	const second = planes.documents.open(guid);
	await Promise.all([first.whenReady, second.whenReady]);
	let destroyed = false;
	first.doc.once('destroy', () => {
		destroyed = true;
	});

	expect(first.doc).toBe(second.doc);
	first[Symbol.dispose]();
	expect(destroyed).toBe(false);
	second[Symbol.dispose]();
	expect(destroyed).toBe(true);
	await planes[Symbol.asyncDispose]();
});

test('disposing one opened document releases only its local observers', async () => {
	const definition = createDefinition();
	const planes = await createBrowserWorkspaceDocumentPlanes(definition, {
		authority: { kind: 'local' },
		documentGcTime: 0,
	});
	const workspace = await openWorkspaceFromService(definition, {
		service: createService(definition),
		expectedKind: 'standalone',
		kv: planes.kv,
		documents: planes.documents,
	});
	const first = workspace.tables.notes.docs.body.open('note-1');
	const second = workspace.tables.notes.docs.body.open('note-1');
	await Promise.all([first.whenReady, second.whenReady]);
	let observed = 0;
	first.observeLocalUpdate(() => {
		observed++;
	});

	first[Symbol.dispose]();
	second.content.write('still open');

	expect(observed).toBe(0);
	second[Symbol.dispose]();
	await workspace[Symbol.asyncDispose]();
	await planes[Symbol.asyncDispose]();
});

test('server document stores hide the principal behind the authority hash', async () => {
	const principalId = asPrincipalId('private-principal');
	const name = await browserWorkspaceDocumentDatabaseName('workspace-v1.kv', {
		kind: 'server',
		baseURL: 'https://api.example.com',
		principalId,
	});

	expect(name).toMatch(/^workspace-v1\.kv\.replica-[0-9a-f]{64}$/);
	expect(name).not.toContain(principalId);
});
