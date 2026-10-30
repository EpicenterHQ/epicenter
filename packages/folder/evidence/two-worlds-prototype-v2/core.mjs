// PROTOTYPE v2 (throwaway): ADR-0692 as revised. A permanent document; rows keyed by stable id with the
// path as an attribute; settings as one map; LFS pointers; deterministic materialization; parsing a Git
// tree with the id repair rule; structured three-way merges for pushes.
import * as Y from '@y/y';
import { applyText, merge3Text } from '../two-worlds-prototype/core.mjs';

export { applyText, merge3Text };

let counter = 0;
export const newId = () =>
	`r${Date.now().toString(36)}${(counter++).toString(36).padStart(4, '0')}`;
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);

// ---- canonical layout: <table>/<name>.md rows, kv.json, LFS pointers; everything else is "outside" ----
const LFS_HEADER = 'version https://git-lfs.github.com/spec/v1\n';
export const isRowPath = (p) =>
	/^[^/]+\/[^/]+\.md$/.test(p) && !p.startsWith('.');
export const isPointer = (text) => text.startsWith(LFS_HEADER);
export const pointerText = ({ oid, size }) =>
	`${LFS_HEADER}oid sha256:${oid}\nsize ${size}\n`;
export function readPointer(text) {
	const m = /oid sha256:([0-9a-f]+)\nsize (\d+)/.exec(text);
	return m ? { oid: m[1], size: Number(m[2]) } : null;
}

// ---- frontmatter: a tiny deterministic writer and Bun's YAML parser ----
const plain = /^[A-Za-z][A-Za-z0-9 _./-]*$/;
const scalar = (v) =>
	typeof v === 'string'
		? plain.test(v) &&
			!/^(true|false|null|yes|no|~)$/i.test(v) &&
			v.trim() === v
			? v
			: JSON.stringify(v)
		: JSON.stringify(v);
/** id first, then the declared order (when the document carries one), then the remaining keys sorted. */
export function orderKeys(keys, declared = []) {
	const rest = keys.filter((k) => k !== 'id' && !declared.includes(k)).sort();
	return [
		...(keys.includes('id') ? ['id'] : []),
		...declared.filter((k) => keys.includes(k)),
		...rest,
	];
}
export function writeRowText({ id, fields, body }, declared) {
	const all = { id, ...fields },
		keys = orderKeys(Object.keys(all), declared);
	const text = body === '' ? '' : body.endsWith('\n') ? body : body + '\n';
	return `---\n${keys.map((k) => `${k}: ${scalar(all[k])}`).join('\n')}\n---\n${text}`;
}
export function writeKvText(kv, declared) {
	const keys = orderKeys(Object.keys(kv), declared);
	return (
		JSON.stringify(Object.fromEntries(keys.map((k) => [k, kv[k]])), null, 2) +
		'\n'
	);
}
/** A file's row value. `raw` when its frontmatter cannot be read: the source is kept byte for byte. */
export function parseRowText(text) {
	if (!text.startsWith('---\n')) return { fields: {}, body: text };
	const end = text.indexOf('\n---\n', 3),
		close = end === -1 && text.endsWith('\n---') ? text.length - 4 : end;
	if (close === -1) return { raw: true, source: text };
	try {
		const fields = Bun.YAML.parse(text.slice(4, close)) ?? {};
		if (typeof fields !== 'object' || Array.isArray(fields))
			return { raw: true, source: text };
		return { fields, body: text.slice(close + 5) };
	} catch {
		return { raw: true, source: text };
	}
}

// ---- the document ----
// rows:  id -> node { path, raw? } with child 0 = fields node (attrs), child 1 = body node (text)
// kv:    setting -> value
// blobs: path -> { oid, size }
// meta:  'order:<table>' -> declared key order, 'order:kv' -> declared setting order (written by the app)
export function readState(doc) {
	const rows = new Map();
	for (const [id, n] of doc.get('rows').attrEntries())
		if (n) {
			const a = n.getAttrs(),
				[f, b] = [n.get(0), n.get(1)];
			rows.set(
				id,
				a.raw
					? { path: a.path, raw: true, source: b.toArray().join('') }
					: { path: a.path, fields: f.getAttrs(), body: b.toArray().join('') },
			);
		}
	return {
		rows,
		kv: doc.get('kv').getAttrs(),
		blobs: new Map(Object.entries(doc.get('blobs').getAttrs())),
		meta: doc.get('meta').getAttrs(),
	};
}
export function writeRow(doc, id, row) {
	const root = doc.get('rows');
	let n = root.getAttr(id);
	doc.transact(() => {
		if (row === undefined) {
			if (n) root.deleteAttr(id);
			return;
		}
		if (!n) {
			n = new Y.Node();
			root.setAttr(id, n);
			n.insert(0, [new Y.Node(), new Y.Node()]);
		}
		if (n.getAttr('path') !== row.path) n.setAttr('path', row.path);
		if (!!n.getAttr('raw') !== !!row.raw)
			row.raw ? n.setAttr('raw', true) : n.deleteAttr('raw');
		const f = n.get(0),
			current = f.getAttrs(),
			fields = row.raw ? {} : row.fields;
		for (const k of Object.keys(current)) if (!(k in fields)) f.deleteAttr(k);
		for (const [k, v] of Object.entries(fields))
			if (!same(current[k], v)) f.setAttr(k, v);
		applyText(n.get(1), row.raw ? row.source : row.body);
	});
}
export function writeKv(doc, kv) {
	const m = doc.get('kv'),
		cur = m.getAttrs();
	doc.transact(() => {
		for (const k of Object.keys(cur)) if (!(k in kv)) m.deleteAttr(k);
		for (const [k, v] of Object.entries(kv))
			if (!same(cur[k], v)) m.setAttr(k, v);
	});
}
export function writeBlobs(doc, blobs) {
	const m = doc.get('blobs'),
		cur = m.getAttrs();
	doc.transact(() => {
		for (const p of Object.keys(cur)) if (!blobs.has(p)) m.deleteAttr(p);
		for (const [p, v] of blobs) if (!same(cur[p], v)) m.setAttr(p, v);
	});
}
export function writeState(doc, state) {
	const cur = readState(doc);
	for (const id of new Set([...cur.rows.keys(), ...state.rows.keys()]))
		if (!same(cur.rows.get(id), state.rows.get(id)))
			writeRow(doc, id, state.rows.get(id));
	writeKv(doc, state.kv);
	writeBlobs(doc, state.blobs);
}

/** The files a checkpoint writes for the document's state. Two rows claiming one path: the later id gets a suffix. */
export function materialize(state, outside = new Map()) {
	const files = new Map(outside),
		byPath = new Map();
	for (const id of [...state.rows.keys()].sort()) {
		const r = state.rows.get(id);
		const list = byPath.get(r.path) ?? [];
		list.push(id);
		byPath.set(r.path, list);
	}
	for (const [path, ids] of byPath)
		ids.forEach((id, i) => {
			const r = state.rows.get(id),
				at = i === 0 ? path : path.replace(/\.md$/, `-${i + 1}.md`);
			files.set(
				at,
				r.raw
					? r.source
					: writeRowText(
							{ id, fields: r.fields, body: r.body },
							state.meta[`order:${path.split('/')[0]}`],
						),
			);
		});
	if (Object.keys(state.kv).length)
		files.set('kv.json', writeKvText(state.kv, state.meta['order:kv']));
	for (const [p, b] of state.blobs) files.set(p, pointerText(b));
	return files;
}

/**
 * A Git tree's structured state, deciding each row's id in order: its own `id` if no other file has it;
 * otherwise the id of the row the reference state has at that path; otherwise a new id.
 */
export function parseTree(files, reference = { rows: new Map() }) {
	const atPath = new Map([...reference.rows].map(([id, r]) => [r.path, id]));
	const rows = new Map(),
		outside = new Map(),
		blobs = new Map();
	let kv = {},
		kvRaw = null;
	const parsed = [];
	for (const [path, text] of [...files].sort(([a], [b]) => (a < b ? -1 : 1))) {
		if (path === 'kv.json') {
			try {
				kv = JSON.parse(text);
			} catch {
				kvRaw = text;
			}
			continue;
		}
		if (isPointer(text)) {
			blobs.set(path, readPointer(text));
			continue;
		}
		if (!isRowPath(path)) {
			outside.set(path, text);
			continue;
		}
		parsed.push({ path, value: parseRowText(text) });
	}
	const claims = new Map();
	for (const { value } of parsed)
		if (typeof value.fields?.id === 'string')
			claims.set(value.fields.id, (claims.get(value.fields.id) ?? 0) + 1);
	const taken = new Set();
	for (const { path, value } of parsed) {
		const own =
			typeof value.fields?.id === 'string' ? value.fields.id : undefined;
		const ownUsable =
			own &&
			!taken.has(own) &&
			(claims.get(own) === 1 || atPath.get(path) === own);
		const id = ownUsable
			? own
			: atPath.has(path) && !taken.has(atPath.get(path))
				? atPath.get(path)
				: newId();
		taken.add(id);
		if (value.raw) rows.set(id, { path, raw: true, source: value.source });
		else {
			const { id: _drop, ...fields } = value.fields;
			rows.set(id, { path, fields, body: value.body });
		}
	}
	// a second pass would let a duplicate that sorts first keep the id the reference gave its path
	return { rows, kv, kvRaw, blobs, outside };
}

// ---- structured three-way merge (reject on overlap): rows by id, then path, fields by key, body by line ----
function mergeScalar(b, a, p) {
	if (same(a, p) || same(a, b)) return { v: p };
	if (same(p, b)) return { v: a };
	return { conflict: true };
}
function mergeMap(b = {}, a = {}, p = {}) {
	const out = {};
	for (const k of new Set([
		...Object.keys(b),
		...Object.keys(a),
		...Object.keys(p),
	])) {
		const r = mergeScalar(b[k], a[k], p[k]);
		if (r.conflict) return { conflict: k };
		if (r.v !== undefined) out[k] = r.v;
	}
	return { v: out };
}
export function mergeRow(b, a, p) {
	if (same(a, p) || same(a, b)) return { v: p };
	if (same(p, b)) return { v: a };
	if (a === undefined || p === undefined) return { v: a ?? p }; // an edit beats a delete it never saw
	const path = mergeScalar(b?.path, a.path, p.path);
	if (path.conflict) return { conflict: 'path' };
	if (a.raw || p.raw || b?.raw) {
		const t = merge3Text(
			b?.raw ? b.source : '',
			a.raw ? a.source : '',
			p.raw ? p.source : '',
			'reject',
		);
		return t.conflict
			? { conflict: 'source' }
			: { v: { path: path.v, raw: true, source: t.text } };
	}
	const fields = mergeMap(b?.fields, a.fields, p.fields);
	if (fields.conflict) return { conflict: `field ${fields.conflict}` };
	const body = merge3Text(b?.body ?? '', a.body, p.body, 'reject');
	if (body.conflict) return { conflict: 'body' };
	return { v: { path: path.v, fields: fields.v, body: body.text } };
}
export function mergeStates(B, A, P) {
	const rows = new Map();
	for (const id of new Set([
		...B.rows.keys(),
		...A.rows.keys(),
		...P.rows.keys(),
	])) {
		const r = mergeRow(B.rows.get(id), A.rows.get(id), P.rows.get(id));
		if (r.conflict)
			return {
				conflict: `${(A.rows.get(id) ?? P.rows.get(id)).path}: ${r.conflict}`,
			};
		if (r.v !== undefined) rows.set(id, r.v);
	}
	const kv = mergeMap(B.kv, A.kv, P.kv);
	if (kv.conflict) return { conflict: `kv.json: ${kv.conflict}` };
	const mergePaths = (b, a, p, label) => {
		const out = new Map();
		for (const k of new Set([...b.keys(), ...a.keys(), ...p.keys()])) {
			const r = mergeScalar(b.get(k), a.get(k), p.get(k));
			if (r.conflict) return { conflict: `${label} ${k}` };
			if (r.v !== undefined) out.set(k, r.v);
		}
		return { v: out };
	};
	const blobs = mergePaths(B.blobs, A.blobs, P.blobs, 'blob');
	if (blobs.conflict) return blobs;
	const outside = mergePaths(B.outside, A.outside, P.outside, 'file');
	if (outside.conflict) return outside;
	return { state: { rows, kv: kv.v, blobs: blobs.v }, outside: outside.v };
}
