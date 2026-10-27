// PROTOTYPE (throwaway): the shared document, deterministic seeding, line diffs and three-way merges.
// Runs unchanged in Bun and in browsers.
import * as Y from '@y/y';

export const SEED_VERSION = 'seed-1';
export const identity = (repo, commit, seedVersion = SEED_VERSION) => `${repo}/${commit}/${seedVersion}`;
export function fnv32(s) { let h = 2166136261; for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 16777619) >>> 0; return h; }

/** The seed is a pure function of (identity, files): fixed client id, path order, key order. */
export function seedUpdate(id, files) {
  const d = new Y.Doc({ guid: id }); d.clientID = fnv32(id);
  const root = d.get('files');
  d.transact(() => {
    for (const path of [...files.keys()].sort()) {
      const f = files.get(path), n = new Y.Node(); root.setAttr(path, n);
      for (const k of Object.keys(f.fields).sort()) n.setAttr(k, f.fields[k]);
      const b = new Y.Node(); n.insert(0, [b]); if (f.body) b.insert(0, f.body);
    }
  });
  return Y.encodeStateAsUpdateV2(d);
}
/** A device's working doc: the seed applied into a doc with the device's own random client id. */
export function seededDoc(id, files, update = seedUpdate(id, files)) { const d = new Y.Doc({ guid: id }); Y.applyUpdateV2(d, update, 'seed'); return d; }

export function readFiles(doc) {
  const out = new Map();
  for (const [p, n] of doc.get('files').attrEntries()) if (n) out.set(p, { fields: n.getAttrs(), body: n.get(0).toArray().join('') });
  return out;
}
export const fileKey = f => f === undefined ? '\u0000absent' : JSON.stringify([Object.entries(f.fields).sort(([a], [b]) => a < b ? -1 : 1), f.body]);
export const sameFile = (a, b) => fileKey(a) === fileKey(b);
export const sameFiles = (a, b) => a.size === b.size && [...a].every(([p, f]) => sameFile(f, b.get(p)));

// ---- line diff (LCS) ----
export const lines = t => t.match(/[^\n]*\n|[^\n]+$/g) ?? [];
/** Hunks over line indices: a[aStart,aEnd) is replaced by b[bStart,bEnd). */
export function lineDiff(a, b) {
  const n = a.length, m = b.length, L = Array.from({ length: n + 1 }, () => new Uint32Array(m + 1));
  for (let i = n - 1; i >= 0; i--) for (let j = m - 1; j >= 0; j--) L[i][j] = a[i] === b[j] ? L[i + 1][j + 1] + 1 : Math.max(L[i + 1][j], L[i][j + 1]);
  const hunks = []; let i = 0, j = 0, open = null;
  const close = () => { if (open) { open.aEnd = i; open.bEnd = j; hunks.push(open); open = null; } };
  while (i < n || j < m) {
    if (i < n && j < m && a[i] === b[j]) { close(); i++; j++; }
    else { open ??= { aStart: i, bStart: j }; if (j < m && (i === n || L[i][j + 1] >= L[i + 1][j])) j++; else i++; }
  }
  close(); return hunks;
}
/** Turn `from` into `to` inside a Yjs text node with the smallest edits a line diff finds. */
export function applyText(node, to) {
  const from = node.toArray().join(''); if (from === to) return;
  const a = lines(from), b = lines(to), offsets = [0]; for (const l of a) offsets.push(offsets.at(-1) + l.length);
  for (const h of lineDiff(a, b).reverse()) {
    let at = offsets[h.aStart], oldText = a.slice(h.aStart, h.aEnd).join(''), newText = b.slice(h.bStart, h.bEnd).join('');
    let p = 0; while (p < oldText.length && p < newText.length && oldText[p] === newText[p]) p++;
    let s = 0; while (s < oldText.length - p && s < newText.length - p && oldText[oldText.length - 1 - s] === newText[newText.length - 1 - s]) s++;
    at += p; const del = oldText.length - p - s, ins = newText.slice(p, newText.length - s);
    if (del) node.delete(at, del); if (ins) node.insert(at, ins);
  }
}

// ---- three-way merge ----
/** mode 'reject': overlapping different changes are a conflict. mode 'keep-both': theirs, then mine. */
export function merge3Text(base, mine, theirs, mode) {
  const B = lines(base), M = lines(mine), T = lines(theirs);
  const hm = lineDiff(B, M).map(h => ({ ...h, side: 'm' })), ht = lineDiff(B, T).map(h => ({ ...h, side: 't' }));
  const all = [...hm, ...ht].sort((x, y) => x.aStart - y.aStart || x.aEnd - y.aEnd), groups = [];
  for (const h of all) { const g = groups.at(-1); if (g && h.aStart <= g.aEnd) { g.hunks.push(h); g.aEnd = Math.max(g.aEnd, h.aEnd); } else groups.push({ aStart: h.aStart, aEnd: h.aEnd, hunks: [h] }); }
  const side = (g, s, X) => { let out = '', i = g.aStart; for (const h of g.hunks.filter(h => h.side === s)) { out += B.slice(i, h.aStart).join('') + X.slice(h.bStart, h.bEnd).join(''); i = h.aEnd; } return out + B.slice(i, g.aEnd).join(''); };
  let out = '', i = 0, conflict = false;
  for (const g of groups) {
    out += B.slice(i, g.aStart).join(''); i = g.aEnd;
    const sides = new Set(g.hunks.map(h => h.side)), mt = side(g, 'm', M), tt = side(g, 't', T);
    if (sides.size === 1) out += sides.has('m') ? mt : tt;
    else if (mt === tt) out += mt;
    else { conflict = true; out += tt + mt; }
  }
  out += B.slice(i).join('');
  return mode === 'reject' && conflict ? { conflict: true } : { conflict, text: out };
}
const EMPTY = { fields: {}, body: '' };
/** Per file: fields by key, the body by line. A missing file is a delete; an edit beats a delete it never saw. */
export function merge3File(base, mine, theirs, mode) {
  if (sameFile(mine, theirs)) return { file: mine };
  if (sameFile(mine, base)) return { file: theirs };
  if (sameFile(theirs, base)) return { file: mine };
  if (mine === undefined) return { file: theirs };
  if (theirs === undefined) return { file: mine };
  const b = base ?? EMPTY, fields = {}; let conflict = false;
  for (const k of new Set([...Object.keys(b.fields), ...Object.keys(mine.fields), ...Object.keys(theirs.fields)])) {
    const [vb, vm, vt] = [b.fields[k], mine.fields[k], theirs.fields[k]].map(v => JSON.stringify(v));
    const pick = vm === vt || vt === vb ? mine.fields[k] : vm === vb ? theirs.fields[k] : (conflict = true, mine.fields[k]);
    if (pick !== undefined) fields[k] = pick;
  }
  const body = merge3Text(b.body, mine.body, theirs.body, mode);
  if (mode === 'reject' && (conflict || body.conflict)) return { conflict: true };
  return { file: { fields, body: body.text }, conflict: conflict || body.conflict };
}
export function merge3Files(base, mine, theirs, mode) {
  const out = new Map(); let conflict = false;
  for (const p of new Set([...base.keys(), ...mine.keys(), ...theirs.keys()])) {
    const r = merge3File(base.get(p), mine.get(p), theirs.get(p), mode);
    if (r.conflict && mode === 'reject') return { conflict: true, path: p };
    conflict ||= !!r.conflict; if (r.file !== undefined) out.set(p, r.file);
  }
  return { files: out, conflict };
}

/** Write a file into the doc with minimal operations; `undefined` deletes it. */
export function writeFile(doc, path, file) {
  const root = doc.get('files'); let n = root.getAttr(path);
  doc.transact(() => {
    if (file === undefined) { if (n) root.deleteAttr(path); return; }
    if (!n) { n = new Y.Node(); root.setAttr(path, n); const b = new Y.Node(); n.insert(0, [b]); }
    const current = n.getAttrs();
    for (const k of Object.keys(current)) if (!(k in file.fields)) n.deleteAttr(k);
    for (const [k, v] of Object.entries(file.fields)) if (JSON.stringify(current[k]) !== JSON.stringify(v)) n.setAttr(k, v);
    applyText(n.get(0), file.body);
  });
}
export function writeFiles(doc, from, to) { for (const p of new Set([...from.keys(), ...to.keys()])) if (!sameFile(from.get(p), to.get(p))) writeFile(doc, p, to.get(p)); }
export const bodyNode = (doc, path) => doc.get('files').getAttr(path).get(0);
