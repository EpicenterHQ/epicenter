import { Database } from 'bun:sqlite';
import { expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import {
	existsSync,
	mkdtempSync,
	readdirSync,
	readFileSync,
	rmSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import * as Y from 'yjs';
import { openStandaloneWorkspace } from './bun.js';
import { defineTable } from './definition.js';
import type { WorkspaceDocumentRuntime } from './document-client.js';
import { document } from './document-format.js';
import { field } from './field.js';
import { PORTABLE_WORKSPACE_FORMAT } from './portable-workspace.js';
import {
	exportPortableWorkspace,
	readPortableTables,
} from './portable-workspace-bun.js';
import type { ReplicaSyncPort } from './replica.js';
import type { TablesAuthorityPort } from './replica-http.js';
import { applyPortableTables } from './tables-apply-bun.js';
import { defineTestWorkspace as defineWorkspace } from './test-workspace.js';

test('exports a complete folder and replans edited tables at the latest head', async () => {
	const root = mkdtempSync(join(tmpdir(), 'epicenter-portable-'));
	const destination = join(root, 'workspace');
	const bytes = new Uint8Array([1, 2, 3]);
	const hash = createHash('sha256').update(bytes).digest('hex');
	const definition = defineWorkspace({
		appId: 'portable-test',
		tables: {
			notes: defineTable({
				fields: {
					id: field.string(),
					title: field.string(),
					attachment: field.blob(),
					body: field.doc(document.plainText),
				},
			}),
		},
	});
	const docs = new Map<string, Y.Doc>();
	const documents: WorkspaceDocumentRuntime = {
		open(guid) {
			let doc = docs.get(guid);
			if (!doc) {
				doc = new Y.Doc({ guid });
				docs.set(guid, doc);
			}
			return {
				doc,
				whenReady: Promise.resolve(),
				[Symbol.dispose]() {},
			};
		},
	};
	const workspace = await openStandaloneWorkspace<
		typeof definition.tables,
		WorkspaceDocumentRuntime
	>(definition, {
		storage: { kind: 'memory' },
		onObserverError() {},
		documents,
	});

	try {
		const row = await workspace.tables.notes.create({
			title: 'Portable',
			attachment: { hash, size: bytes.byteLength, mediaType: 'text/plain' },
		});
		const body = workspace.tables.notes.docs.body.open(row.id);
		await body.whenReady;
		body.content.write('Complete document');
		body[Symbol.dispose]();

		const manifest = await exportPortableWorkspace(definition, workspace, {
			directory: destination,
			readBlob: async () => bytes,
		});

		expect(manifest.format).toBe(PORTABLE_WORKSPACE_FORMAT);
		expect(manifest.tablesStateHash).toMatch(/^sha256:[0-9a-f]{64}$/);
		expect(manifest.content.tables.rows).toBe(1);
		expect(manifest.content.documents).toHaveLength(1);
		expect(manifest.content.blobs).toEqual([
			{
				path: `blobs/${hash}`,
				hash,
				size: 3,
				mediaType: 'text/plain',
			},
		]);
		expect(readdirSync(destination).toSorted()).toEqual([
			'blobs',
			'documents',
			'kv.json',
			'tables.sqlite3',
			'workspace.json',
		]);
		expect(
			JSON.parse(readFileSync(join(destination, 'kv.json'), 'utf8')),
		).toEqual({});

		const sqlite = new Database(join(destination, 'tables.sqlite3'), {
			readonly: true,
			strict: true,
		});
		try {
			expect(
				sqlite
					.query<{ name: string }, []>(
						"SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name",
					)
					.all(),
			).toEqual([{ name: 'notes' }]);
			const stored = sqlite
				.query<{ id: string; title: string; attachment: string }, []>(
					'SELECT id, title, attachment FROM notes',
				)
				.get();
			expect(stored?.id).toBe(row.id);
			expect(stored?.title).toBe('Portable');
			expect(JSON.parse(stored?.attachment ?? '')).toEqual({
				hash,
				size: 3,
				mediaType: 'text/plain',
			});
		} finally {
			sqlite.close();
		}

		const documentEntry = manifest.content.documents[0];
		expect(documentEntry).toBeDefined();
		const exportedDoc = new Y.Doc();
		Y.applyUpdateV2(
			exportedDoc,
			new Uint8Array(
				readFileSync(join(destination, documentEntry?.path ?? 'missing')),
			),
		);
		expect(exportedDoc.getText('content').toString()).toBe('Complete document');
		expect(readFileSync(join(destination, `blobs/${hash}`))).toEqual(
			Buffer.from(bytes),
		);

		const edited = new Database(join(destination, 'tables.sqlite3'));
		try {
			edited.run('UPDATE notes SET title = ?', ['Edited outside Epicenter']);
		} finally {
			edited.close();
		}
		expect(
			readPortableTables(definition, join(destination, 'tables.sqlite3')),
		).toEqual([
			{
				table: 'notes',
				rowId: row.id,
				cells: {
					title: 'Edited outside Epicenter',
					attachment: {
						hash,
						size: 3,
						mediaType: 'text/plain',
					},
				},
			},
		]);

		const reviews: { head: number; before: unknown; after: unknown }[] = [];
		const applyHeads: number[] = [];
		let stateReads = 0;
		const authority: ReplicaSyncPort & TablesAuthorityPort = {
			bindWorkspace() {},
			async openAuthority() {
				return {
					recordsEpoch: 'epoch-1',
					recordsDescriptor: definition.recordsDescriptor,
					recordsSchemaHash: definition.recordsSchemaHash,
				};
			},
			async readTablesState() {
				stateReads++;
				return {
					kind: 'tablesState',
					ok: true,
					head: stateReads === 1 ? 4 : 5,
					rows: [
						{
							table: 'notes',
							rowId: row.id,
							cells: {
								title: stateReads === 1 ? 'Portable' : 'Concurrent',
								attachment: {
									hash,
									size: 3,
									mediaType: 'text/plain',
								},
							},
						},
					],
				};
			},
			async applyTables(request) {
				applyHeads.push(request.expectedHead);
				return request.expectedHead === 4
					? { kind: 'tablesApply', ok: false, reason: 'head-moved' }
					: { kind: 'tablesApply', ok: true, newHead: 6 };
			},
			async push() {
				throw new Error('unexpected push');
			},
			async pull() {
				throw new Error('unexpected pull');
			},
			async snapshotChunk() {
				throw new Error('unexpected snapshot');
			},
		};
		expect(
			await applyPortableTables(definition, {
				tablesPath: join(destination, 'tables.sqlite3'),
				authority,
				isBlobAvailable: async (ref) => ref.hash === hash,
				confirm(plan, head) {
					const title = plan.updates[0]?.changes.title;
					reviews.push({
						head,
						before: title?.before,
						after: title?.after,
					});
					return true;
				},
			}),
		).toEqual({ status: 'applied', head: 6 });
		expect(reviews).toEqual([
			{
				head: 4,
				before: 'Portable',
				after: 'Edited outside Epicenter',
			},
			{
				head: 5,
				before: 'Concurrent',
				after: 'Edited outside Epicenter',
			},
		]);
		expect(applyHeads).toEqual([4, 5]);
	} finally {
		await workspace[Symbol.asyncDispose]();
		for (const doc of docs.values()) doc.destroy();
		rmSync(root, { recursive: true, force: true });
	}
});

test('complete export leaves no destination when referenced blob bytes fail validation', async () => {
	const root = mkdtempSync(join(tmpdir(), 'epicenter-portable-fail-'));
	const destination = join(root, 'workspace');
	const definition = defineWorkspace({
		appId: 'portable-fail-test',
		tables: {
			files: defineTable({
				fields: { id: field.string(), value: field.blob() },
			}),
		},
	});
	const workspace = await openStandaloneWorkspace(definition, {
		storage: { kind: 'memory' },
		onObserverError() {},
	});

	try {
		await workspace.tables.files.create({
			value: { hash: '0'.repeat(64), size: 1, mediaType: 'text/plain' },
		});
		await expect(
			exportPortableWorkspace(definition, workspace, {
				directory: destination,
				readBlob: async () => new Uint8Array([1]),
			}),
		).rejects.toThrow('failed hashing');
		expect(existsSync(destination)).toBe(false);
	} finally {
		await workspace[Symbol.asyncDispose]();
		rmSync(root, { recursive: true, force: true });
	}
});
