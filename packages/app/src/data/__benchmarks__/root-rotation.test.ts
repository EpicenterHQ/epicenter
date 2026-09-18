/**
 * Root replacement experiment, pinned to the installed Yjs 14 implementation.
 * Verifies plain-text fidelity, the loss of stale writes, concurrent subtree
 * selection, and retained writer metadata. These are not production reset tests.
 */
import { expect, test } from 'bun:test';
import * as Y from '@y/y';
import { deleteRow, updateRow } from '../store/document.js';
import {
	encode,
	put,
	reconstruct,
	reopen,
	rows,
	seed,
	visible,
} from './root-rotation.fixture.js';

test('replacing the parent preserves fixture values through a cold open and collects deleted descendants', () => {
	const doc = seed();
	for (let i = 0; i < 1000; i++) {
		doc.transact(() => put(rows(doc), `dead-${i}`, 'Deleted'));
		doc.transact(() => deleteRow(rows(doc), `dead-${i}`));
	}
	const saved = visible(doc);
	const before = encode(doc).length;
	reconstruct(doc);
	const reopened = reopen(encode(doc));
	expect(visible(reopened)).toEqual(saved);
	expect(encode(doc).length).toBeLessThan(before);
	reopened.destroy();
	doc.destroy();
});

test('folding accepts offline edits while replacing their parent discards them', () => {
	const source = seed();
	const offline = reopen(encode(source));
	const vector = Y.encodeStateVector(offline);
	offline.transact(() => {
		updateRow(rows(offline), 'live-0', { title: 'Offline' });
		put(rows(offline), 'offline-new', 'New');
	});
	const delta = Y.encodeStateAsUpdateV2(offline, vector);
	const folded = reopen(encode(source));
	Y.applyUpdateV2(folded, delta);
	expect(visible(folded).find((row) => row.id === 'live-0')?.fields.title).toBe(
		'Offline',
	);
	expect(visible(folded).some((row) => row.id === 'offline-new')).toBe(true);
	const saved = visible(source);
	reconstruct(source);
	Y.applyUpdateV2(source, delta);
	expect(visible(source)).toEqual(saved);
	Y.applyUpdateV2(offline, encode(source));
	expect(visible(offline)).toEqual(saved);
	for (const doc of [source, offline, folded]) doc.destroy();
});

test('concurrent replacements converge by selecting one whole subtree', () => {
	const left = seed();
	const right = reopen(encode(left));
	left.transact(() => put(rows(left), 'left', 'Left'));
	right.transact(() => put(rows(right), 'right', 'Right'));
	reconstruct(left);
	reconstruct(right);
	const leftUpdate = encode(left);
	Y.applyUpdateV2(left, encode(right));
	Y.applyUpdateV2(right, leftUpdate);
	expect(visible(left)).toEqual(visible(right));
	expect(
		visible(left).filter((row) => row.id === 'left' || row.id === 'right'),
	).toHaveLength(1);
	left.destroy();
	right.destroy();
});

test('replacement retains historical writer IDs while a fresh document resets them', () => {
	const doc = seed();
	const initial = encode(doc);
	const vector = Y.encodeStateVector(doc);
	for (let i = 0; i < 10; i++) {
		const peer = reopen(initial);
		peer.transact(() => put(rows(peer), `dead-${i}`, 'Deleted'));
		peer.transact(() => deleteRow(rows(peer), `dead-${i}`));
		Y.applyUpdateV2(doc, Y.encodeStateAsUpdateV2(peer, vector));
		peer.destroy();
	}
	const writers = [...doc.store.clients.keys()];
	reconstruct(doc);
	for (const writer of writers)
		expect(doc.store.clients.has(writer)).toBe(true);
	const fresh = reconstruct(doc, true);
	expect(fresh.store.clients.size).toBe(1);
	expect(visible(fresh)).toEqual(visible(doc));
	fresh.destroy();
	doc.destroy();
});

test('a root-scoped undo manager retains the removed subtree', () => {
	const doc = seed();
	const saved = visible(doc);
	const undo = new Y.UndoManager(doc.get('application'));
	const before = encode(doc).length;
	reconstruct(doc);
	expect(encode(doc).length).toBeGreaterThan(before);
	undo.undo();
	expect(visible(doc)).toEqual(saved);
	undo.destroy();
	doc.destroy();
});
