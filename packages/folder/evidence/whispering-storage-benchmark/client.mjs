// Throwaway data-layer experiment. Never opens an application database.
import * as Y from '@y/y';
import { Check } from 'typebox/value';
import { whisperingTables } from '../../../../apps/whispering/src/lib/definition.ts';
import { emptyTree } from '../../src/browser/git/snapshot.ts';
import { openRepository } from '../../src/browser/repository.ts';
import { openStorage } from '../../src/browser/storage.ts';
import { hashObject, writeTree } from '../../src/git/raw-objects.ts';
import { changeMarkdown } from '../../src/shared/markdown-codec.ts';

const variant = BENCH_VARIANT;
const names = Object.keys(whisperingTables);
const encoder = new TextEncoder();
const request = (r) =>
	new Promise((resolve, reject) => {
		r.onsuccess = () => resolve(r.result);
		r.onerror = () => reject(r.error);
	});
const completed = (t) =>
	new Promise((resolve, reject) => {
		t.oncomplete = resolve;
		t.onabort = t.onerror = () => reject(t.error);
	});
let repository,
	database,
	doc,
	currentId,
	projections = new Map(),
	fixtureCount;
let retainedRows, retainedPaths;
let nextSequence = 1;
const text = (label, size) =>
	(
		label +
		'\n' +
		'The meeting covered the product design, next steps, and open questions. '.repeat(
			Math.ceil(size / 68),
		)
	).slice(0, size) + '\n';
function fixture(count) {
	const rows = [];
	for (const name of names)
		for (let i = 0; i < count; i++) {
			const id = `20261027-120000-${String(i).padStart(6, '0')}`;
			const createdAt = '2026-10-27T04:00:00.000Z';
			let fields, body;
			switch (name) {
				case 'recordings':
					fields = {
						title: `Recording ${i}`,
						recordedAt: createdAt,
						durationMs: 45000 + i,
						capture: 'microphone',
					};
					body = text(`Notes ${i}`, 150);
					break;
				case 'transcriptions':
					fields = {
						recordingId: id,
						createdAt,
						model: 'whisper-1',
						endpoint: 'https://example.invalid/transcribe',
					};
					body = text(`Transcript ${i}`, 3000);
					break;
				case 'transformations':
					fields = { title: `Recipe ${i}`, model: null };
					body = text(`Instructions ${i}`, 600);
					break;
				case 'transformation_runs':
					fields = {
						recordingId: id,
						transcriptionId: id,
						transformationId: id,
						transformationTitle: `Recipe ${i}`,
						createdAt,
						model: 'example-model',
						endpoint: 'https://example.invalid/text',
						prompt: text(`Prompt ${i}`, 400),
						input: text(`Input ${i}`, 3000),
					};
					body = text(`Output ${i}`, 1800);
					break;
				case 'text_runs':
					fields = {
						transformationId: id,
						transformationTitle: `Recipe ${i}`,
						createdAt,
						model: 'example-model',
						endpoint: 'https://example.invalid/text',
						prompt: text(`Prompt ${i}`, 400),
						input: text(`Pasted input ${i}`, 2500),
					};
					body = text(`Text output ${i}`, 1800);
					break;
				default:
					throw new Error('Unexpected table');
			}
			const changed = changeMarkdown(null, { fields, body });
			if (changed.error || !Check(whisperingTables[name], fields))
				throw new Error('Invalid fixture');
			rows.push({ table: name, id, fields, body, markdown: changed.data.text });
		}
	return rows;
}
async function openY(id) {
	const r = indexedDB.open(`PROTOTYPE-whispering-yjs-${id}`, 1);
	r.onupgradeneeded = () => r.result.createObjectStore('updates');
	database = await request(r);
}
function projected(name, id, node) {
	let cache = projections.get(name);
	if (!cache) projections.set(name, (cache = new Map()));
	if (cache.has(id)) return cache.get(id);
	const fields = node.getAttrs();
	const body = node.get(0).toArray().join('');
	if (!Check(whisperingTables[name], fields))
		throw new Error('Yjs schema check failed');
	const row = { id, fields, body, issues: null };
	cache.set(id, row);
	return row;
}
async function lists() {
	if (variant !== 'yjs') {
		const [tables, paths] = await Promise.all([
			Promise.all(
				names.map(async (name) => {
					const r = await repository.tables[name].list();
					if (r.error) throw new Error(String(r.error));
					return r.data;
				}),
			),
			repository.files.list().then((r) => {
				if (r.error) throw new Error(String(r.error));
				return r.data;
			}),
		]);
		return { tables, paths };
	}
	const tables = names.map((name) =>
		[...doc.get(`tables:${name}`).attrEntries()]
			.sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
			.map(([id, node]) => projected(name, id, node)),
	);
	const paths = names
		.flatMap((name, index) =>
			tables[index].map((row) => `${name}/${row.id}.md`),
		)
		.sort();
	return { tables, paths };
}
function digest(tables) {
	let hash = 2166136261,
		count = 0;
	function feed(s) {
		for (let i = 0; i < s.length; i++)
			hash = Math.imul(hash ^ s.charCodeAt(i), 16777619) >>> 0;
	}
	for (const table of tables)
		for (const row of table) {
			if (row.issues || !row.fields) throw new Error('Invalid projected row');
			feed(
				JSON.stringify([
					row.id,
					Object.entries(row.fields).sort(([a], [b]) =>
						a < b ? -1 : a > b ? 1 : 0,
					),
					row.body,
				]),
			);
			count++;
		}
	return { count, hash };
}
globalThis.storageBenchmark = {
	async seed(id, count) {
		fixtureCount = count;
		const rows = fixture(count);
		const manifest = {
			tables: names.map((name) => ({
				name,
				rows: count,
				markdownBytes: rows
					.filter((row) => row.table === name)
					.reduce((n, row) => n + encoder.encode(row.markdown).byteLength, 0),
			})),
			expected: digest(
				names.map((name) => rows.filter((row) => row.table === name)),
			),
			seedMs: 0,
		};
		const start = performance.now();
		if (variant === 'yjs') {
			await openY(id);
			const seeded = new Y.Doc();
			seeded.transact(() => {
				for (const row of rows) {
					const node = new Y.Node();
					seeded.get(`tables:${row.table}`).setAttr(row.id, node);
					for (const [key, value] of Object.entries(row.fields))
						node.setAttr(key, value);
					const body = new Y.Node();
					node.insert(0, [body]);
					body.insert(0, row.body);
				}
			});
			const bytes = Y.encodeStateAsUpdateV2(seeded);
			const t = database.transaction('updates', 'readwrite', {
				durability: 'strict',
			});
			const done = completed(t);
			t.objectStore('updates').put(bytes, 0);
			await done;
			manifest.logicalStoredBytes = bytes.byteLength;
			database.close();
		} else {
			const objects = new Map();
			const entries = new Map(names.map((name) => [name, []]));
			for (let offset = 0; offset < rows.length; offset += 256)
				await Promise.all(
					rows.slice(offset, offset + 256).map(async (row) => {
						const object = {
							type: 'blob',
							bytes: encoder.encode(row.markdown),
						};
						const oid = await hashObject(object);
						objects.set(oid, object);
						entries
							.get(row.table)
							.push({
								mode: '100644',
								name: encoder.encode(`${row.id}.md`),
								oid,
							});
					}),
				);
			const rootEntries = [];
			for (const [name, children] of entries) {
				const object = { type: 'tree', bytes: writeTree(children) };
				const oid = await hashObject(object);
				objects.set(oid, object);
				rootEntries.push({ mode: '40000', name: encoder.encode(name), oid });
			}
			const rootObject = { type: 'tree', bytes: writeTree(rootEntries) };
			const root = await hashObject(rootObject);
			objects.set(root, rootObject);
			const storage = await openStorage(id);
			await storage.publish({
				expected: emptyTree,
				workingTree: root,
				objects,
				retiredBytes: 0,
				paths: [],
			});
			storage.close();
			manifest.logicalStoredBytes = [...objects.values()].reduce(
				(n, object) => n + object.bytes.byteLength,
				0,
			);
		}
		manifest.seedMs = performance.now() - start;
		return manifest;
	},
	async load(id) {
		currentId = id;
		projections = new Map();
		const start = performance.now();
		let opened, replayed;
		if (variant === 'yjs') {
			await openY(id);
			opened = performance.now();
			let updates;
			{
				const t = database.transaction('updates');
				const done = completed(t);
				updates = await request(t.objectStore('updates').getAll());
				await done;
			}
			if (!updates.length) throw new Error('Missing document');
			doc = new Y.Doc();
			for (const bytes of updates) Y.applyUpdateV2(doc, bytes);
			nextSequence = updates.length;
			updates = undefined;
			replayed = performance.now();
		} else {
			repository = await openRepository(id, whisperingTables);
			opened = performance.now();
			replayed = opened;
		}
		const listed = await lists();
		retainedRows = listed.tables;
		retainedPaths = listed.paths;
		const ready = performance.now();
		return {
			openMs: opened - start,
			replayMs: replayed - opened,
			listMs: ready - replayed,
			readyMs: ready - start,
			counts: retainedRows.map((rows) => rows.length),
			files: retainedPaths.length,
		};
	},
	validate() {
		return digest(retainedRows);
	},
	async warm() {
		const start = performance.now();
		const listed = await lists();
		retainedRows = listed.tables;
		retainedPaths = listed.paths;
		return { ms: performance.now() - start, validation: digest(retainedRows) };
	},
	async edit(iteration) {
		const id = '20261027-120000-000000',
			name = 'transcriptions';
		const old = retainedRows[names.indexOf(name)].find((row) => row.id === id);
		const body = `${old.body}Edit ${iteration}\n`;
		const start = performance.now();
		let inMemoryMs = null,
			updateBytes = null;
		if (variant === 'yjs') {
			let update;
			const listen = (bytes) => {
				update = bytes;
			};
			doc.on('updateV2', listen);
			const target = doc.get(`tables:${name}`).getAttr(id).get(0);
			target.insert(target.length, `Edit ${iteration}\n`);
			doc.off('updateV2', listen);
			projections.get(name).delete(id);
			inMemoryMs = performance.now() - start;
			if (!update) throw new Error('Missing update');
			updateBytes = update.byteLength;
			const t = database.transaction('updates', 'readwrite', {
				durability: 'strict',
			});
			const done = completed(t);
			t.objectStore('updates').add(update, nextSequence++);
			await done;
		} else {
			const markdown = changeMarkdown(
				{ text: old.text, issues: null },
				{ body },
			);
			if (markdown.error) throw new Error('Edit framing failed');
			const result = await repository.files.write(
				`${name}/${id}.md`,
				markdown.data.text,
			);
			if (result.error) throw new Error(String(result.error));
		}
		const durableMs = performance.now() - start;
		const refreshStart = performance.now();
		if (variant === 'yjs') {
			const rows = [...doc.get(`tables:${name}`).attrEntries()]
				.sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
				.map(([id, node]) => projected(name, id, node));
			retainedRows[names.indexOf(name)] = rows;
		} else {
			const result = await repository.tables[name].list();
			if (result.error) throw new Error(String(result.error));
			retainedRows[names.indexOf(name)] = result.data;
		}
		if (
			retainedRows[names.indexOf(name)].find((row) => row.id === id).body !==
			body
		)
			throw new Error('Edit lost during refresh');
		return {
			inMemoryMs,
			updateBytes,
			durableMs,
			refreshMs: performance.now() - refreshStart,
			totalMs: performance.now() - start,
		};
	},
	async reset() {
		const id = '20261027-120000-000000',
			name = 'transcriptions',
			body = text('Transcript 0', 3000);
		if (variant === 'yjs') {
			const node = doc.get(`tables:${name}`).getAttr(id).get(0);
			doc.transact(() => {
				node.delete(0, node.length);
				node.insert(0, body);
			});
			const bytes = Y.encodeStateAsUpdateV2(doc);
			const t = database.transaction('updates', 'readwrite', {
				durability: 'strict',
			});
			const done = completed(t);
			t.objectStore('updates').clear();
			t.objectStore('updates').put(bytes, 0);
			await done;
		} else {
			const old = retainedRows[names.indexOf(name)].find(
				(row) => row.id === id,
			);
			const changed = changeMarkdown(
				{ text: old.text, issues: null },
				{ body },
			);
			if (changed.error) throw new Error('Reset failed');
			const r = await repository.files.write(
				`${name}/${id}.md`,
				changed.data.text,
			);
			if (r.error) throw new Error(String(r.error));
		}
	},
};
