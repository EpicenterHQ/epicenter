import * as Y from '@y/y';
import { identity, readFiles, seedUpdate } from './core.mjs';
import { fixture } from './fixture.mjs';

const req = (r) =>
	new Promise((ok, no) => {
		r.onsuccess = () => ok(r.result);
		r.onerror = () => no(r.error);
	});
const db = () => {
	const r = indexedDB.open('PROTOTYPE-two-worlds', 1);
	r.onupgradeneeded = () => r.result.createObjectStore('s');
	return req(r);
};
const hex = async (b) =>
	[...new Uint8Array(await crypto.subtle.digest('SHA-256', b))]
		.map((x) => x.toString(16).padStart(2, '0'))
		.join('');
globalThis.proto = {
	async seed(count) {
		const files = fixture(count),
			t0 = performance.now();
		const u = seedUpdate(identity('braden/whispering', 'c0ffee'), files);
		const seedMs = performance.now() - t0;
		const d = await db();
		const t = d.transaction('s', 'readwrite', { durability: 'strict' });
		t.objectStore('s').put(u, count);
		await new Promise((ok) => (t.oncomplete = ok));
		return { seedMs, bytes: u.byteLength, sha256: await hex(u) };
	},
	async open(count) {
		const t0 = performance.now();
		const d = await db();
		const u = await req(d.transaction('s').objectStore('s').get(count));
		const read = performance.now();
		const doc = new Y.Doc();
		Y.applyUpdateV2(doc, u);
		const applied = performance.now();
		const files = readFiles(doc);
		const ready = performance.now();
		return {
			readMs: read - t0,
			applyMs: applied - read,
			projectMs: ready - applied,
			openMs: ready - t0,
			files: files.size,
		};
	},
};
