#!/usr/bin/env bun
/**
 * YJS Update Overhead Benchmark
 *
 * Measures CRDT overhead for repeated updates, testing both the best case
 * (same-key updates where GC structs merge) and the worst case (interleaved
 * multi-key add/remove where GC structs can't merge).
 *
 * Usage: bun run update-overhead.ts
 */
import * as Y from '@y/y';

type Entry = { key: string; val: ReturnType<typeof row>; ts: number };

function kvSet(yarray: Y.Node<{ children: Entry }>, doc: Y.Doc, key: string, val: ReturnType<typeof row>) {
	doc.transact(() => {
		const entries = yarray.toArray();
		const idx = entries.findIndex((e) => e.key === key);
		if (idx !== -1) yarray.delete(idx);
		yarray.push([{ key, val, ts: Date.now() }]);
	});
}

function kvDelete(yarray: Y.Node<{ children: Entry }>, doc: Y.Doc, key: string) {
	doc.transact(() => {
		const entries = yarray.toArray();
		const idx = entries.findIndex((e) => e.key === key);
		if (idx !== -1) yarray.delete(idx);
	});
}

function size(doc: Y.Doc): number {
	return Y.encodeStateAsUpdate(doc).byteLength;
}

function fmt(bytes: number): string {
	if (bytes < 1024) return `${bytes} B`;
	if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(2)} KB`;
	return `${(bytes / (1024 * 1024)).toFixed(2)} MB`;
}

function header(title: string) {
	console.log('');
	console.log('─'.repeat(70));
	console.log(title);
	console.log('─'.repeat(70));
}

const row = (i: number) => ({
	id: `skill_${i}`,
	name: `skill-${i}`,
	description: `Description for skill ${i}`,
	license: 'MIT',
	compatibility: 'Claude Code',
	updatedAt: Date.now(),
});

// ═══════════════════════════════════════════════════════════════════════
// TEST 1: Same-key updates (GC structs merge: best case)
// ═══════════════════════════════════════════════════════════════════════

header('TEST 1: Same-key updates (GC structs merge)');

const doc1 = new Y.Doc();
const arr1 = doc1.get('data') as Y.Node<{ children: Entry }>;
kvSet(arr1, doc1, 'skill_0', row(0));
const baseline1 = size(doc1);

for (let i = 0; i < 500; i++) {
	kvSet(arr1, doc1, 'skill_0', { ...row(0), description: `Edit ${i}` });
}

const fresh1 = new Y.Doc();
const freshArr1 = fresh1.get('data') as Y.Node<{ children: Entry }>;
kvSet(freshArr1, fresh1, 'skill_0', { ...row(0), description: 'Edit 499' });

console.log(`Baseline (1 insert):    ${fmt(baseline1)}`);
console.log(`After 500 updates:      ${fmt(size(doc1))}`);
console.log(`Fresh (same data):      ${fmt(size(fresh1))}`);
console.log(`Overhead:               ${((size(doc1) / size(fresh1) - 1) * 100).toFixed(1)}%`);

// ═══════════════════════════════════════════════════════════════════════
// TEST 2: Interleaved add/remove (GC structs CAN'T merge: worst case)
// ═══════════════════════════════════════════════════════════════════════

header('TEST 2: Interleaved add 10 / remove 5 cycles');

const doc2 = new Y.Doc();
const arr2 = doc2.get('data') as Y.Node<{ children: Entry }>;
let nextId = 0;
let activeKeys: string[] = [];

for (let cycle = 0; cycle < 10; cycle++) {
	// Add 10
	for (let i = 0; i < 10; i++) {
		const key = `skill_${nextId++}`;
		kvSet(arr2, doc2, key, row(nextId));
		activeKeys.push(key);
	}
	// Remove 5 (from the front)
	for (let i = 0; i < 5; i++) {
		const key = activeKeys.shift()!;
		kvDelete(arr2, doc2, key);
	}
}

// Fresh doc with same final data
const fresh2 = new Y.Doc();
const freshArr2 = fresh2.get('data') as Y.Node<{ children: Entry }>;
for (const key of activeKeys) {
	kvSet(freshArr2, fresh2, key, row(Number(key.split('_')[1])));
}

console.log(`Active keys:            ${activeKeys.length}`);
console.log(`Total adds:             ${nextId}`);
console.log(`Total removes:          ${nextId - activeKeys.length}`);
console.log(`Current size:           ${fmt(size(doc2))}`);
console.log(`Fresh (same data):      ${fmt(size(fresh2))}`);
console.log(`Overhead:               ${((size(doc2) / size(fresh2) - 1) * 100).toFixed(1)}%`);

// ═══════════════════════════════════════════════════════════════════════
// TEST 3: The exact pattern from the question
// "add 10, remove 5, add 10, remove 5, remove 10"
// ═══════════════════════════════════════════════════════════════════════

header('TEST 3: add 10, remove 5, add 10, remove 5, remove 10');

const doc3 = new Y.Doc();
const arr3 = doc3.get('data') as Y.Node<{ children: Entry }>;
let id3 = 0;
let keys3: string[] = [];

const snap = (label: string) => {
	console.log(`  ${label.padEnd(30)} ${fmt(size(doc3)).padStart(10)}  (${keys3.length} active)`);
};

// Add 10
for (let i = 0; i < 10; i++) {
	const key = `s_${id3++}`;
	kvSet(arr3, doc3, key, row(id3));
	keys3.push(key);
}
snap('After add 10');

// Remove 5
for (let i = 0; i < 5; i++) kvDelete(arr3, doc3, keys3.shift()!);
snap('After remove 5');

// Add 10
for (let i = 0; i < 10; i++) {
	const key = `s_${id3++}`;
	kvSet(arr3, doc3, key, row(id3));
	keys3.push(key);
}
snap('After add 10');

// Remove 5
for (let i = 0; i < 5; i++) kvDelete(arr3, doc3, keys3.shift()!);
snap('After remove 5');

// Remove 10
for (let i = 0; i < 10; i++) kvDelete(arr3, doc3, keys3.shift()!);
snap('After remove 10');

const fresh3 = new Y.Doc();
const freshArr3 = fresh3.get('data') as Y.Node<{ children: Entry }>;
for (const key of keys3) {
	kvSet(freshArr3, fresh3, key, row(Number(key.split('_')[1])));
}
console.log(`  ${'Fresh (same data)'.padEnd(30)} ${fmt(size(fresh3)).padStart(10)}  (${keys3.length} active)`);
console.log(`  Overhead: ${((size(doc3) / Math.max(size(fresh3), 1) - 1) * 100).toFixed(1)}%`);

// ═══════════════════════════════════════════════════════════════════════
// TEST 4: Y.Node text with interleaved typing (for comparison)
// ═══════════════════════════════════════════════════════════════════════

header('TEST 4: Y.Node text: type 100 chars, delete 50, type 100, delete 50');

const doc4 = new Y.Doc();
const text4 = doc4.get('content', 'text');
const phrase = 'The quick brown fox jumps over the lazy dog. ';

// Type 100
for (let i = 0; i < 100; i++) text4.insert(text4.length, phrase[i % phrase.length]);
console.log(`After type 100:         ${fmt(size(doc4))}`);

// Delete 50 from start
text4.delete(0, 50);
console.log(`After delete 50:        ${fmt(size(doc4))}`);

// Type 100 more
for (let i = 0; i < 100; i++) text4.insert(text4.length, phrase[i % phrase.length]);
console.log(`After type 100 more:    ${fmt(size(doc4))}`);

// Delete 50
text4.delete(0, 50);
console.log(`After delete 50:        ${fmt(size(doc4))}`);

// Fresh comparison
const fresh4 = new Y.Doc();
fresh4.get('content', 'text').insert(0, text4.toString());
console.log(`Fresh (same text):      ${fmt(size(fresh4))}`);
console.log(`Overhead:               ${((size(doc4) / size(fresh4) - 1) * 100).toFixed(1)}%`);

// ═══════════════════════════════════════════════════════════════════════
// TEST 5: Y.Node text with gc:false (what instruction docs use)
// ═══════════════════════════════════════════════════════════════════════

header('TEST 5: Y.Node text gc:false: type 100, delete 50, type 100, delete 50');

const doc5 = new Y.Doc({ gc: false });
const text5 = doc5.get('content', 'text');

for (let i = 0; i < 100; i++) text5.insert(text5.length, phrase[i % phrase.length]);
console.log(`After type 100:         ${fmt(size(doc5))}`);

text5.delete(0, 50);
console.log(`After delete 50:        ${fmt(size(doc5))}`);

for (let i = 0; i < 100; i++) text5.insert(text5.length, phrase[i % phrase.length]);
console.log(`After type 100 more:    ${fmt(size(doc5))}`);

text5.delete(0, 50);
console.log(`After delete 50:        ${fmt(size(doc5))}`);

const fresh5 = new Y.Doc({ gc: false });
fresh5.get('content', 'text').insert(0, text5.toString());
console.log(`Fresh (same text):      ${fmt(size(fresh5))}`);
console.log(`Overhead:               ${((size(doc5) / size(fresh5) - 1) * 100).toFixed(1)}%`);

// ═══════════════════════════════════════════════════════════════════════

header('SUMMARY');
console.log('Same-key updates:       GC structs merge → ~fixed overhead');
console.log('Multi-key add/remove:   GC structs interleaved → overhead scales');
console.log('Y.Node text gc:true:         Deleted chars → small GC structs');
console.log('Y.Node text gc:false:        Deleted chars retain full content → grows fast');
console.log('');
