import * as Y from '@y/y';

let doc;
let database;
let nextUpdate = 1;
const req = (r) =>
	new Promise((resolve, reject) => {
		r.onsuccess = () => resolve(r.result);
		r.onerror = () => reject(r.error);
	});
const done = (t) =>
	new Promise((resolve, reject) => {
		t.oncomplete = () => resolve();
		t.onabort = t.onerror = () => reject(t.error);
	});
async function open(name) {
	const r = indexedDB.open(`PROTOTYPE-vault-yjs-${name}`, 1);
	r.onupgradeneeded = () => r.result.createObjectStore('updates');
	database = await req(r);
}
globalThis.vaultBench = {
	async seed(name) {
		const corpus = await (await fetch(`/corpus/${name}`)).json();
		await open(name);
		const start = performance.now();
		const seeded = new Y.Doc();
		const files = seeded.get('files');
		seeded.transact(() => {
			for (const [path, source] of corpus) {
				const text = new Y.Node();
				files.setAttr(path, text);
				text.insert(0, source);
			}
		});
		const importMs = performance.now() - start;
		const encodingStart = performance.now();
		const bytes = Y.encodeStateAsUpdateV2(seeded);
		const encodeMs = performance.now() - encodingStart;
		const t = database.transaction('updates', 'readwrite', {
			durability: 'strict',
		});
		const completion = done(t);
		t.objectStore('updates').put(bytes, 0);
		await completion;
		return {
			importMs,
			encodeMs,
			encodedBytes: bytes.byteLength,
			files: corpus.length,
		};
	},
	async load(name) {
		const start = performance.now();
		await open(name);
		const opened = performance.now();
		let updates;
		{
			const t = database.transaction('updates');
			const completion = done(t);
			updates = await req(t.objectStore('updates').getAll());
			await completion;
		}
		if (!updates?.length) throw new Error('Missing vault state');
		nextUpdate = updates.length;
		const read = performance.now();
		doc = new Y.Doc();
		for (const bytes of updates) Y.applyUpdateV2(doc, bytes);
		const applied = performance.now();
		updates = undefined;
		const count = [...doc.get('files').attrKeys()].length;
		return {
			openMs: opened - start,
			readMs: read - opened,
			applyMs: applied - read,
			readyMs: applied - start,
			files: count,
		};
	},
	validate() {
		let files = 0,
			utf16Units = 0,
			checksum = 2166136261;
		const feed = (s) => {
			for (let i = 0; i < s.length; i++)
				checksum = Math.imul(checksum ^ s.charCodeAt(i), 16777619) >>> 0;
			checksum = Math.imul(checksum ^ 65535, 16777619) >>> 0;
		};
		for (const path of [...doc.get('files').attrKeys()].sort()) {
			const text = doc.get('files').getAttr(path);
			files++;
			utf16Units += text.length;
			feed(path);
			feed(text.toArray().join(''));
		}
		return { files, utf16Units, checksum };
	},
	async edit(path) {
		let update;
		const listen = (u) => {
			update = u;
		};
		doc.on('updateV2', listen);
		const start = performance.now();
		doc
			.get('files')
			.getAttr(path)
			.insert(
				0,
				`Benchmark edit
`,
			);
		const edited = performance.now();
		doc.off('updateV2', listen);
		if (!update) throw new Error('No incremental update');
		const t = database.transaction('updates', 'readwrite', {
			durability: 'strict',
		});
		const completion = done(t);
		t.objectStore('updates').add(update, nextUpdate++);
		await completion;
		return {
			inMemoryMs: edited - start,
			durableMs: performance.now() - start,
			updateBytes: update.byteLength,
		};
	},
	async compact() {
		const start = performance.now();
		const bytes = Y.encodeStateAsUpdateV2(doc);
		const encoded = performance.now();
		const t = database.transaction('updates', 'readwrite', {
			durability: 'strict',
		});
		const completion = done(t);
		t.objectStore('updates').clear();
		t.objectStore('updates').put(bytes, 0);
		await completion;
		return {
			encodeMs: encoded - start,
			durableMs: performance.now() - start,
			encodedBytes: bytes.byteLength,
		};
	},
};
