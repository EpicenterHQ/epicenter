// Throwaway experiment: storage layout, not representation. Never opens an application database.
import * as Y from '@y/y';
import { whisperingTables } from '../../../../apps/whispering/src/lib/definition.ts';
import { readRow } from '../../src/shared/row.ts';
import { changeMarkdown } from '../../src/shared/markdown-codec.ts';

const names = Object.keys(whisperingTables);
const enc = new TextEncoder(), dec = new TextDecoder();
const req = r => new Promise((ok, no) => { r.onsuccess = () => ok(r.result); r.onerror = () => no(r.error); });
const done = t => new Promise((ok, no) => { t.oncomplete = ok; t.onabort = t.onerror = () => no(t.error); });
const text = (label, size) => (label + '\n' + 'The meeting covered the product design, next steps, and open questions. '.repeat(Math.ceil(size / 68))).slice(0, size) + '\n';
function fixture(count) {
  const rows = [];
  for (const name of names) for (let i = 0; i < count; i++) {
    const id = `20261027-120000-${String(i).padStart(6, '0')}`, createdAt = '2026-10-27T04:00:00.000Z';
    let fields, body;
    switch (name) {
      case 'recordings': fields = { title: `Recording ${i}`, recordedAt: createdAt, durationMs: 45000 + i, capture: 'microphone' }; body = text(`Notes ${i}`, 150); break;
      case 'transcriptions': fields = { recordingId: id, createdAt, model: 'whisper-1', endpoint: 'https://example.invalid/transcribe' }; body = text(`Transcript ${i}`, 3000); break;
      case 'transformations': fields = { title: `Recipe ${i}`, model: null }; body = text(`Instructions ${i}`, 600); break;
      case 'transformation_runs': fields = { recordingId: id, transcriptionId: id, transformationId: id, transformationTitle: `Recipe ${i}`, createdAt, model: 'example-model', endpoint: 'https://example.invalid/text', prompt: text(`Prompt ${i}`, 400), input: text(`Input ${i}`, 3000) }; body = text(`Output ${i}`, 1800); break;
      case 'text_runs': fields = { transformationId: id, transformationTitle: `Recipe ${i}`, createdAt, model: 'example-model', endpoint: 'https://example.invalid/text', prompt: text(`Prompt ${i}`, 400), input: text(`Pasted input ${i}`, 2500) }; body = text(`Text output ${i}`, 1800); break;
    }
    const c = changeMarkdown(null, { fields, body }); if (c.error) throw new Error('fixture');
    rows.push({ table: name, id, fields, body, markdown: c.data.text });
  }
  return rows;
}
async function openDb(name) {
  const r = indexedDB.open(name, 1);
  r.onupgradeneeded = () => { r.result.createObjectStore('pack'); r.result.createObjectStore('log'); };
  return req(r);
}
async function getAll(db, store) { const t = db.transaction(store); const d = done(t); const v = await req(t.objectStore(store).getAll()); await d; return v; }
async function put(db, store, value, key, clear = false) { const t = db.transaction(store, 'readwrite', { durability: 'strict' }); const d = done(t); if (clear) t.objectStore(store).clear(); t.objectStore(store).put(value, key); await d; }
function digest(mirror) { let h = 2166136261, n = 0; for (const [path, row] of [...mirror].sort(([a], [b]) => a < b ? -1 : 1)) { const s = JSON.stringify([path, row.fields, row.body]); for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 16777619) >>> 0; n++; } return { n, h }; }
const T = 'transcriptions/20261027-120000-000000.md';
let db, mirror, doc, seq;

// packed: every file's Markdown in ONE record; edits append a whole-file record to a log keyed by sequence.
const packed = {
  async seed(id, count) {
    db = await openDb(`PROTOTYPE-packed-${id}`);
    const rows = fixture(count), parts = rows.map(r => enc.encode(r.markdown));
    const total = parts.reduce((n, p) => n + p.byteLength, 0), bytes = new Uint8Array(total), index = [];
    let off = 0; rows.forEach((r, i) => { bytes.set(parts[i], off); index.push([`${r.table}/${r.id}.md`, off, parts[i].byteLength]); off += parts[i].byteLength; });
    const t0 = performance.now(); await put(db, 'pack', { index, bytes }, 0); return { storedBytes: total, seedMs: performance.now() - t0 };
  },
  async load(id) {
    const t0 = performance.now(); db = await openDb(`PROTOTYPE-packed-${id}`);
    const [pack] = await getAll(db, 'pack'), log = await getAll(db, 'log'); const read = performance.now();
    const texts = new Map(); for (const [p, o, l] of pack.index) texts.set(p, pack.bytes.subarray(o, o + l));
    for (const { path, markdown } of log) texts.set(path, markdown); seq = log.length;
    mirror = new Map(); for (const [p, t] of texts) { const slash = p.indexOf('/'); const name = p.slice(0, slash); mirror.set(p, readRow(p.slice(slash + 1, -3), typeof t === 'string' ? t : dec.decode(t), whisperingTables[name])); }
    const ready = performance.now(); return { readMs: read - t0, parseMs: ready - read, readyMs: ready - t0, logRecords: log.length };
  },
  async edit(body) {
    const t0 = performance.now(); const old = mirror.get(T); const c = changeMarkdown({ text: old.text, issues: null }, { body }); if (c.error) throw new Error('edit');
    await put(db, 'log', { path: T, markdown: c.data.text }, seq++);
    mirror.set(T, readRow(T.slice(15, -3), c.data.text, whisperingTables.transcriptions)); return performance.now() - t0;
  },
  async compact() {
    const t0 = performance.now(); const index = [], parts = []; let off = 0;
    for (const [p, row] of mirror) { const b = enc.encode(row.text); parts.push(b); index.push([p, off, b.byteLength]); off += b.byteLength; }
    const bytes = new Uint8Array(off); let o = 0; for (const b of parts) { bytes.set(b, o); o += b.byteLength; }
    const t = db.transaction(['pack', 'log'], 'readwrite', { durability: 'strict' }); const d = done(t); t.objectStore('pack').put({ index, bytes }, 0); t.objectStore('log').clear(); await d;
    return { ms: performance.now() - t0, bytes: off };
  },
  body: () => mirror.get(T).body,
  validate: () => digest(mirror),
};

// yjs: one Y.Doc; fields as attrs, body as text node; edits are character inserts/deletes (real typing), each update persisted.
const yjs = {
  async seed(id, count) {
    db = await openDb(`PROTOTYPE-ytyping-${id}`); const d = new Y.Doc();
    d.transact(() => { for (const r of fixture(count)) { const n = new Y.Node(); d.get(`tables:${r.table}`).setAttr(r.id, n); for (const [k, v] of Object.entries(r.fields)) n.setAttr(k, v); const b = new Y.Node(); n.insert(0, [b]); b.insert(0, r.body); } });
    const bytes = Y.encodeStateAsUpdateV2(d); const t0 = performance.now(); await put(db, 'pack', bytes, 0); return { storedBytes: bytes.byteLength, seedMs: performance.now() - t0 };
  },
  async load(id) {
    const t0 = performance.now(); db = await openDb(`PROTOTYPE-ytyping-${id}`);
    const [base] = await getAll(db, 'pack'), log = await getAll(db, 'log'); const read = performance.now();
    doc = new Y.Doc(); Y.applyUpdateV2(doc, base); for (const u of log) Y.applyUpdateV2(doc, u); seq = log.length; const applied = performance.now();
    mirror = new Map(); for (const name of names) for (const [id, n] of doc.get(`tables:${name}`).attrEntries()) mirror.set(`${name}/${id}.md`, { fields: n.getAttrs(), body: n.get(0).toArray().join('') });
    const ready = performance.now(); return { readMs: read - t0, applyMs: applied - read, projectMs: ready - applied, readyMs: ready - t0, logRecords: log.length };
  },
  async type(op) {
    const t0 = performance.now(); let u; const l = b => { u = b; }; doc.on('updateV2', l);
    const node = doc.get('tables:transcriptions').getAttr('20261027-120000-000000').get(0);
    if (op.del) node.delete(op.at, 1); else node.insert(op.at, op.ch); doc.off('updateV2', l);
    await put(db, 'log', u, seq++); mirror.set(T, { fields: mirror.get(T).fields, body: node.toArray().join('') }); return { ms: performance.now() - t0, bytes: u.byteLength };
  },
  async compact() {
    const t0 = performance.now(); const bytes = Y.encodeStateAsUpdateV2(doc);
    const t = db.transaction(['pack', 'log'], 'readwrite', { durability: 'strict' }); const d = done(t); t.objectStore('pack').put(bytes, 0); t.objectStore('log').clear(); await d;
    return { ms: performance.now() - t0, bytes: bytes.byteLength };
  },
  // "rebuild at checkpoint": a fresh doc from current text, no history or tombstones.
  async rebuild() {
    const t0 = performance.now(); const d = new Y.Doc();
    d.transact(() => { for (const [p, row] of mirror) { const s = p.indexOf('/'); const n = new Y.Node(); d.get(`tables:${p.slice(0, s)}`).setAttr(p.slice(s + 1, -3), n); for (const [k, v] of Object.entries(row.fields)) n.setAttr(k, v); const b = new Y.Node(); n.insert(0, [b]); b.insert(0, row.body); } });
    const bytes = Y.encodeStateAsUpdateV2(d); return { ms: performance.now() - t0, bytes: bytes.byteLength };
  },
  body: () => mirror.get(T).body,
  validate: () => digest(mirror),
};
// rows: Markdown stays the truth; a parsed-row cache (path, fields, body) is one structured-clone record, rebuilt at checkpoints.
const rows = {
  async seed(id, count) { db = await openDb(`PROTOTYPE-rows-${id}`); const all = fixture(count).map(r => [`${r.table}/${r.id}.md`, r.fields, r.body]); const t0 = performance.now(); await put(db, 'pack', all, 0); return { seedMs: performance.now() - t0 }; },
  async load(id) { const t0 = performance.now(); db = await openDb(`PROTOTYPE-rows-${id}`); const [all] = await getAll(db, 'pack'), log = await getAll(db, 'log'); const read = performance.now();
    mirror = new Map(); for (const [p, fields, body] of all) mirror.set(p, { fields, body }); for (const { path, body } of log) mirror.set(path, { fields: mirror.get(path).fields, body }); seq = log.length; const ready = performance.now(); return { readMs: read - t0, parseMs: ready - read, readyMs: ready - t0 }; },
  async edit(body) { const t0 = performance.now(); mirror.set(T, { fields: mirror.get(T).fields, body }); await put(db, 'log', { path: T, body }, seq++); return performance.now() - t0; },
  async compact() { const t0 = performance.now(); const t = db.transaction(['pack', 'log'], 'readwrite', { durability: 'strict' }); const d = done(t); t.objectStore('pack').put([...mirror].map(([p, r]) => [p, r.fields, r.body]), 0); t.objectStore('log').clear(); await d; return { ms: performance.now() - t0 }; },
  body: () => mirror.get(T).body, validate: () => digest(mirror),
};
globalThis.bench = BENCH_VARIANT === 'packed' ? packed : BENCH_VARIANT === 'rows' ? rows : yjs;
