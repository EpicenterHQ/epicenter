/**
 * THROWAWAY PROTOTYPE: does one repository revision cause material retries
 * while two real tabs save and one adopts incoming data? Scratch IndexedDB,
 * real field/region merge, inflated Git objects, simulated fetch/push only.
 * No production storage, network credentials, collection, or crash claims.
 */
import { merge } from '../../src/merge-file.js';

type ObjectRecord = { type: 'blob' | 'tree' | 'commit'; bytes: Uint8Array };
type State = { revision: number; B: string; C: string };
type Entry = { path: string; oid: string };
type Config = { rows: number; large: boolean; saveEvery: number; duration: number; delay: number; samePath: boolean };
const encoder = new TextEncoder();
const decoder = new TextDecoder();
const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));
let db: IDBDatabase;
let config: Config;
let stopped = false;
const events: { phase: string; ok: boolean; window: number; revision: number; observed: number; at: number }[] = [];
const saves: { actor: string; path: string; count: number; retries: number; latency: number }[] = [];
const syncs: { round: number; retries: number; latency: number; published: boolean; whileSaving: boolean }[] = [];

function request<T>(value: IDBRequest<T>): Promise<T> {
	return new Promise((resolve, reject) => { value.onsuccess = () => resolve(value.result); value.onerror = () => reject(value.error); });
}
function complete(tx: IDBTransaction) {
	return new Promise<void>((resolve, reject) => { tx.oncomplete = () => resolve(); tx.onabort = () => reject(tx.error ?? Error('aborted')); tx.onerror = () => reject(tx.error); });
}
async function object(type: ObjectRecord['type'], bytes: Uint8Array) {
	const header = encoder.encode(`${type} ${bytes.length}\0`);
	const input = new Uint8Array(header.length + bytes.length);
	input.set(header); input.set(bytes, header.length);
	const oid = Array.from(new Uint8Array(await crypto.subtle.digest('SHA-1', input)), (byte) => byte.toString(16).padStart(2, '0')).join('');
	return { oid, record: { type, bytes } };
}
function treeBytes(entries: Entry[], directory = false) {
	const chunks = entries.map(({ path, oid }) => {
		const name = encoder.encode(`${directory ? '40000' : '100644'} ${path}\0`);
		const chunk = new Uint8Array(name.length + 20); chunk.set(name);
		for (let i = 0; i < 20; i++) chunk[name.length + i] = parseInt(oid.slice(i * 2, i * 2 + 2), 16);
		return chunk;
	});
	const result = new Uint8Array(chunks.reduce((size, chunk) => size + chunk.length, 0));
	let offset = 0; for (const chunk of chunks) { result.set(chunk, offset); offset += chunk.length; }
	return result;
}
function parseTree(bytes: Uint8Array): Entry[] {
	const entries: Entry[] = [];
	for (let at = 0; at < bytes.length;) {
		const zero = bytes.indexOf(0, at); const name = decoder.decode(bytes.slice(at, zero)).split(' ')[1]!;
		const oid = Array.from(bytes.slice(zero + 1, zero + 21), (b) => b.toString(16).padStart(2, '0')).join('');
		entries.push({ path: name, oid }); at = zero + 21;
	}
	return entries;
}
async function build(entries: Entry[], changed: Map<string, string>, parent: string | null, message: string) {
	const objects = new Map<string, ObjectRecord>();
	const next = new Map(entries.map(({ path, oid }) => [path, oid]));
	for (const [path, text] of changed) { const blob = await object('blob', encoder.encode(text)); objects.set(blob.oid, blob.record); next.set(path, blob.oid); }
	const table = await object('tree', treeBytes([...next].sort(([a], [b]) => a.localeCompare(b)).map(([path, oid]) => ({ path, oid }))));
	objects.set(table.oid, table.record);
	const root = await object('tree', treeBytes([{ path: 'cards', oid: table.oid }], true)); objects.set(root.oid, root.record);
	const commit = await object('commit', encoder.encode(`tree ${root.oid}\n${parent ? `parent ${parent}\n` : ''}author Prototype <prototype@example.invalid> 1 +0000\ncommitter Prototype <prototype@example.invalid> 1 +0000\n\n${message}\n`));
	objects.set(commit.oid, commit.record);
	return { oid: commit.oid, objects, entries: [...next].map(([path, oid]) => ({ path, oid })) };
}
async function capture(paths: string[], allEdits = false, useBase = false) {
	const start = performance.now();
	const tx = db.transaction(['meta', 'objects', 'edits'], 'readonly'); const done = complete(tx);
	const state: State = await request(tx.objectStore('meta').get('state'));
	const store = tx.objectStore('objects');
	const commit: ObjectRecord = await request(store.get(useBase ? state.B : state.C));
	const root: ObjectRecord = await request(store.get(decoder.decode(commit.bytes).split('\n')[0]!.slice(5)));
	const table: ObjectRecord = await request(store.get(parseTree(root.bytes)[0]!.oid));
	const entries = parseTree(table.bytes); const byPath = new Map(entries.map((entry) => [entry.path, entry.oid]));
	const edits = new Map<string, string>();
	if (allEdits) {
		const keys = await request(tx.objectStore('edits').getAllKeys());
		const values: string[] = await request(tx.objectStore('edits').getAll());
		keys.forEach((key, index) => edits.set(String(key), values[index]!));
	} else {
		await Promise.all(paths.map(async (path) => { const value = await request(tx.objectStore('edits').get(path)); if (value !== undefined) edits.set(path, value); }));
	}
	const texts = new Map<string, string>();
	await Promise.all([...new Set([...paths, ...edits.keys()])].map(async (path) => {
		const oid = byPath.get(path); if (!oid) throw Error(`missing ${path}`);
		const value: ObjectRecord = await request(store.get(oid)); texts.set(path, decoder.decode(value.bytes));
	}));
	await done;
	return { state, entries, edits, texts, start };
}
async function publish(snapshot: Awaited<ReturnType<typeof capture>>, phase: string, candidate?: Awaited<ReturnType<typeof build>>, remote?: Awaited<ReturnType<typeof build>>, edit?: [string, string]) {
	const tx = db.transaction(['meta', 'objects', 'edits'], 'readwrite'); const done = complete(tx);
	const state: State = await request(tx.objectStore('meta').get('state'));
	const ok = state.revision === snapshot.state.revision;
	const window = performance.now() - snapshot.start;
	if (ok) {
		if (edit) tx.objectStore('edits').put(edit[1], edit[0]);
		if (candidate) {
			for (const [oid, value] of remote?.objects ?? []) tx.objectStore('objects').put(value, oid);
			for (const [oid, value] of candidate.objects) tx.objectStore('objects').put(value, oid);
			state.C = candidate.oid; if (remote) state.B = remote.oid;
			for (const path of snapshot.edits.keys()) tx.objectStore('edits').delete(path);
		}
		state.revision++; tx.objectStore('meta').put(state, 'state');
	}
	await done;
	events.push({ phase, ok, window, revision: snapshot.state.revision, observed: state.revision, at: Date.now() });
	return ok;
}
async function acknowledge(sent: { B: string; C: string }) {
	const tx = db.transaction(['meta'], 'readwrite'); const done = complete(tx);
	const state: State = await request(tx.objectStore('meta').get('state'));
	if (state.B !== sent.B || state.C !== sent.C) throw Error('stale acknowledgement');
	state.B = sent.C; state.revision++; tx.objectStore('meta').put(state, 'state'); await done;
}
function initialText(id: number) {
	const padding = config.large && id === 0 ? Array.from({ length: 512 }, (_, i) => `Paragraph ${i}: ${'ordinary words '.repeat(12)}\n`).join('\n') : 'A short independent paragraph.\n';
	return `---\nid: ${id}\ntabA: 0\ntabB: 0\nserver: 0\n---\nA: initial\n\n${padding}\nB: initial\n\nR: initial\n`;
}
function changeText(text: string, actor: string, count: number) {
	const key = actor === 'R' ? 'server' : `tab${actor}`;
	return text.replace(new RegExp(`^${key}: \\d+$`, 'm'), `${key}: ${count}`).replace(new RegExp(`^${actor}:.*$`, 'm'), `${actor}: save-${actor}-${count}`);
}
async function save(path: string, actor: string, count: number) {
	const start = performance.now(); const initial = await capture([path]);
	const from = initial.edits.get(path) ?? initial.texts.get(path)!;
	const change = changeText(from, actor, count);
	for (let attempt = 0; attempt < 1000; attempt++) {
		const snapshot = attempt === 0 ? initial : await capture([path]);
		const current = snapshot.edits.get(path) ?? snapshot.texts.get(path)!;
		const result = await merge(`${path}`, { base: from, ours: change, theirs: current });
		if (typeof result.content !== 'string') throw Error('expected text');
		if (await publish(snapshot, `save-${actor}`, undefined, undefined, [path, result.content])) {
			saves.push({ actor, path, count, retries: attempt, latency: performance.now() - start }); return;
		}
	}
	throw Error('save exceeded 1000 attempts');
}
async function sync(round: number, maxTime: number, whileSaving: boolean) {
	const paths = Array.from({ length: 50 }, (_, id) => `${String(id).padStart(5, '0')}.md`);
	const prepared = await capture(paths, false, true);
	const incoming = new Map(paths.map((path) => [path, changeText(prepared.texts.get(path)!, 'R', round)]));
	const remote = await build(prepared.entries, incoming, prepared.state.B, `remote ${round}`);
	await sleep(80); // Fetch/response latency is deliberately before the revision snapshot.
	const start = performance.now(); let retries = 0;
	while (performance.now() - start < maxTime) {
		const snapshot = await capture(paths, true);
		if (snapshot.state.B !== prepared.state.B || snapshot.state.C !== snapshot.state.B) throw Error('unexpected ref movement');
		const merged = new Map<string, string>();
		for (const [path, change] of snapshot.edits) {
			const base = snapshot.texts.get(path)!; const current = incoming.get(path) ?? base;
			const result = await merge(path, { base, ours: change, theirs: current });
			if (typeof result.content !== 'string') throw Error('expected merged text'); merged.set(path, result.content);
		}
		const candidate = await build(remote.entries, merged, remote.oid, `local ${round}`);
		if (config.delay) await sleep(config.delay); // Explicit slow-computation injection, never reported as natural work.
		if (await publish(snapshot, 'adopt', candidate, remote)) {
			await sleep(30); await acknowledge({ B: remote.oid, C: candidate.oid });
			syncs.push({ round, retries, latency: performance.now() - start, published: true, whileSaving }); return true;
		}
		retries++;
	}
	syncs.push({ round, retries, latency: performance.now() - start, published: false, whileSaving }); return false;
}
async function open(name: string, settings: Config) {
	config = settings; stopped = false; events.length = 0; saves.length = 0; syncs.length = 0;
	const opening = indexedDB.open(name, 1);
	opening.onupgradeneeded = () => { for (const store of ['meta', 'objects', 'edits']) opening.result.createObjectStore(store); };
	db = await request(opening);
	await merge('warm.md', { base: 'x\n', ours: 'a\nx\n', theirs: 'x\nb\n' });
}
async function seed() {
	const changed = new Map(Array.from({ length: config.rows }, (_, id) => [`${String(id).padStart(5, '0')}.md`, initialText(id)]));
	const candidate = await build([], changed, null, 'initial');
	const tx = db.transaction(['meta', 'objects', 'edits'], 'readwrite'); const done = complete(tx);
	for (const [oid, record] of candidate.objects) tx.objectStore('objects').put(record, oid);
	tx.objectStore('meta').put({ revision: 0, B: candidate.oid, C: candidate.oid }, 'state'); await done;
}
async function writer(actor: string) {
	const start = performance.now(); let count = 0;
	while (!stopped && performance.now() - start < config.duration) {
		count++; const path = `${String(config.samePath ? 0 : ((count + (actor === 'B' ? 25 : 0)) % 50)).padStart(5, '0')}.md`;
		await save(path, actor, count);
		await sleep(config.saveEvery);
	}
	return count;
}
async function syncing() {
	const start = performance.now(); let round = 0;
	while (performance.now() - start < config.duration) { round++; await sync(round, Math.min(1500, config.duration), true); await sleep(30); }
	return round;
}
async function finish(round: number) { stopped = true; return sync(round + 1, 15000, false); }
async function verify(expected: { actor: string; path: string; count: number }[], round: number) {
	const paths = [...new Set([...expected.map(({ path }) => path), ...Array.from({ length: 50 }, (_, id) => `${String(id).padStart(5, '0')}.md`)])];
	const snapshot = await capture(paths, true); const failures: string[] = [];
	for (const { actor, path, count } of expected) {
		const text = snapshot.edits.get(path) ?? snapshot.texts.get(path)!;
		if (!text.includes(`tab${actor}: ${count}\n`) || !text.includes(`${actor}: save-${actor}-${count}\n`)) failures.push(`${actor}/${path}/${count}`);
	}
	for (let id = 0; id < 50; id++) { const text = snapshot.texts.get(`${String(id).padStart(5, '0')}.md`)!; if (!text.includes(`server: ${round}\n`) || !text.includes(`R: save-R-${round}\n`)) failures.push(`remote/${id}/${round}`); }
	return { failures, pending: snapshot.edits.size, revision: snapshot.state.revision, refsEqual: snapshot.state.B === snapshot.state.C };
}
function report() { return { events, saves, syncs }; }
function close() { db.close(); }
declare global {
	var revisionPrototype: { open: typeof open; seed: typeof seed; writer: typeof writer; syncing: typeof syncing; finish: typeof finish; verify: typeof verify; report: typeof report; close: typeof close };
}
Object.assign(globalThis, { revisionPrototype: { open, seed, writer, syncing, finish, verify, report, close } });
