/** Actual working-copy operations with an in-memory folder host and SQLite store. */
import { defineStore } from '@epicenter/app';
import * as Y from '@y/y';
import {
	checkoutLine,
	contentHash,
	createWorkingCopy,
} from '../artifact/checkout.js';
import { defineTable, field, plainText } from '../definition/index.js';
import { createMemoryRecord, openMemory } from '../store/memory.js';
import { syncEngineOf } from '../store/store.js';

const installed = await Bun.file(
	new URL('../../../node_modules/@y/y/package.json', import.meta.url),
).json();
if (installed.version !== '14.0.0-rc.26')
	throw new Error('Revalidate against the new @y/y version');
const definition = defineStore({
	id: 'so.epicenter.checkout-benchmark',
	kv: {},
	tables: {
		notes: defineTable({
			fields: { title: field.string() },
			body: plainText(),
		}),
	},
});
const results = [];
for (const bodySize of [1000, 100000, 1000000]) {
	for (const delivery of ['offline', 'acknowledged-each-push']) {
		for (const operation of [
			'pull',
			'unchanged-push',
			'title-push',
			'body-push',
		]) {
			const record = createMemoryRecord();
			const store = await openMemory(definition, record);
			const data = Object.assign(Object.create(store), {
				dataId: definition.id,
				generation: 1,
				baseURL: 'https://benchmark.invalid',
				principalId: 'benchmark',
			}) as typeof store & {
				dataId: string;
				generation: number;
				baseURL: string;
				principalId: string;
			};
			const row = data.tables.notes.create({ title: 'Baseline' });
			const node = data.tables.notes.body(row.id)! as Y.Node;
			node.insert(0, ['x'.repeat(bodySize)]);
			const doc = node.doc!;
			const engine = syncEngineOf(store);
			const receiver = new Y.Doc({ gc: true });
			let sequence = 0;
			function acknowledge() {
				const pending = engine.coalesce();
				if (!pending) return;
				Y.applyUpdateV2(receiver, pending.bytes);
				engine.acknowledge(pending.id, ++sequence);
			}
			const folder = new Map<string, string>();
			let folderReadBytes = 0;
			let folderWriteBytes = 0;
			const host = (async (
				_input: string | URL | Request,
				init?: RequestInit,
			) => {
				const body = [...folder]
					.map(([path, contents]) => checkoutLine({ path, contents }))
					.join('');
				const etag = `"${await contentHash(body)}"`;
				if (init?.method === 'PUT') {
					if (new Headers(init.headers).get('if-match') !== etag)
						return new Response(null, { status: 412 });
					const incoming = String(init.body);
					folderWriteBytes += Buffer.byteLength(incoming);
					folder.clear();
					for (const line of incoming.split('\n').filter(Boolean)) {
						const file = JSON.parse(line) as { path: string; contents: string };
						folder.set(file.path, file.contents);
					}
					return new Response(null, { status: 204 });
				}
				folderReadBytes += Buffer.byteLength(body);
				return new Response(body, {
					headers: { etag, 'content-type': 'application/x-ndjson' },
				});
			}) as typeof fetch;
			const copy = createWorkingCopy(data, { fetch: host });
			const initial = await copy.pull({ confirm: async () => true });
			if (initial.error) throw new Error(initial.error.message);
			const path = `notes/${row.id}.md`;
			if (!folder.has(path)) throw new Error('Fixture row was not exported');
			// Both scenarios begin with the seed accepted; only subsequent work differs.
			acknowledge();
			await store.persistence.flush();
			folderReadBytes = folderWriteBytes = 0;
			let updateBytes = 0;
			let updateCount = 0;
			doc.on('updateV2', (update: Uint8Array) => {
				updateBytes += update.length;
				updateCount++;
			});
			const baselineBytes = Y.encodeStateAsUpdateV2(doc).length;
			const start = performance.now();
			for (let i = 0; i < 100; i++) {
				if (operation === 'title-push')
					folder.set(
						path,
						folder.get(path)!.replace(/^title:.*$/m, `title: "Title ${i}"`),
					);
				if (operation === 'body-push')
					folder.set(path, folder.get(path)!.replace(/\n$/, 'a\n'));
				const result =
					operation === 'pull'
						? await copy.pull({ confirm: async () => true })
						: await copy.push({ confirm: async () => true });
				if (result.error) throw new Error(result.error.message);
				if (delivery === 'acknowledged-each-push') {
					acknowledge();
					await store.persistence.flush();
				}
			}
			if (
				operation === 'body-push' &&
				node.toString() !== 'x'.repeat(bodySize) + 'a'.repeat(100)
			)
				throw new Error('Body edits did not land');
			if (
				operation === 'title-push' &&
				data.tables.notes.get(row.id)!.title !== 'Title 99'
			)
				throw new Error('Title edits did not land');
			if (
				(operation === 'pull' || operation === 'unchanged-push') &&
				updateCount !== 0
			)
				throw new Error('Read-only workload authored updates');
			const elapsedMs = performance.now() - start;
			const folded = Y.encodeStateAsUpdateV2(doc);
			const startOpen = performance.now();
			const reopened = new Y.Doc({ gc: true });
			Y.applyUpdateV2(reopened, folded);
			const openMs = performance.now() - startOpen;
			const result = {
				bodySize,
				delivery,
				operation,
				iterations: 100,
				elapsedMs,
				updateCount,
				updateBytes,
				baselineBytes,
				foldedBytes: folded.length,
				openMs,
				writers: reopened.store.clients.size,
				structs: [...reopened.store.clients.values()].reduce(
					(n, structs) => n + structs.length,
					0,
				),
				folderReadBytes,
				folderWriteBytes,
			};
			reopened.destroy();
			receiver.destroy();
			await store[Symbol.asyncDispose]();
			const persisted = record.sqlite.all(
				'SELECT COUNT(*) AS rows, SUM(length(bytes)) AS bytes FROM _updates',
			)[0];
			results.push({ ...result, persisted });
			record.close();
		}
	}
}
console.log(
	JSON.stringify(
		{
			package: installed.name,
			version: installed.version,
			bun: Bun.version,
			date: new Date().toISOString(),
			results,
		},
		null,
		2,
	),
);
