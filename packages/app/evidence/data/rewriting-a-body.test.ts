/**
 * What a body rewrite costs two devices, measured rather than reasoned about.
 *
 * `ContentCodec.rewrite` clears a node's content and refills it, on the node
 * the row already holds (ADR-0338). The alternative it was chosen over is
 * setting a fresh node over the row's `content` attribute, and the argument
 * for choosing it was that a replacement resolves by attribute
 * last-writer-wins, so one device loses its entire subtree.
 *
 * That argument is only worth the verb if the rewrite is actually better, and
 * "better" is not "lossless". These pin exactly what survives, so the record
 * can say it and a person can be told it.
 */

import { expect, test } from 'bun:test';
import * as Y from '@y/y';

function sync(a: Y.Doc, b: Y.Doc): void {
	const fromA = Y.encodeStateAsUpdateV2(a, Y.encodeStateVector(b));
	const fromB = Y.encodeStateAsUpdateV2(b, Y.encodeStateVector(a));
	Y.applyUpdateV2(b, fromA);
	Y.applyUpdateV2(a, fromB);
}

/** One block of text, the shape a ProseMirror paragraph has in the document. */
function block(text: string): Y.Type {
	const node = new Y.Type();
	node.insert(0, [text]);
	return node;
}

/** What `rewrite` does, spelled out rather than reached through a codec. */
function rewrite(node: Y.Type, blocks: readonly string[]): void {
	if (node.length > 0) node.delete(0, node.length);
	node.insert(0, blocks.map(block));
}

function bodyOf(doc: Y.Doc): string {
	return [...doc.get('body').map((child: unknown) => String(child))].join('|');
}

test('the node is the same node, which is the whole reason for the verb', () => {
	const doc = new Y.Doc();
	const row = doc.get('notes');
	const node = new Y.Type();
	row.setAttr('content', node as never);
	rewrite(node, ['first']);
	rewrite(node, ['second']);
	// A replacement would have put a different object here, and every editor,
	// undo manager, and preview bound to the old one would be bound to nothing.
	expect(row.getAttr('content')).toBe(node);
	expect([...node.map((child: unknown) => String(child))]).toEqual(['second']);
});

test('two devices rewriting one body concatenate; neither is discarded', () => {
	const a = new Y.Doc();
	const b = new Y.Doc();
	rewrite(a.get('body'), ['original']);
	sync(a, b);

	rewrite(a.get('body'), ['from A']);
	rewrite(b.get('body'), ['from B']);
	sync(a, b);

	// Both survive and both devices agree, ordered by client id rather than by
	// time. A value would have converged on one winner; a rewritten body does
	// not, and that is the cost of the node being merged rather than replaced.
	expect(bodyOf(a)).toBe(bodyOf(b));
	expect(bodyOf(a).split('|').sort()).toEqual(['from A', 'from B']);
});

test('a peer typing INSIDE a block the rewrite removed loses those keystrokes', () => {
	const a = new Y.Doc();
	const b = new Y.Doc();
	rewrite(a.get('body'), ['hello']);
	sync(a, b);

	// B is typing into the paragraph that is already there.
	const typed = b.get('body').get(0) as Y.Type;
	typed.insert(typed.length, [' there']);
	// A answers `file` on the same note.
	rewrite(a.get('body'), ['replaced']);
	sync(a, b);

	// Gone. Deleting a nested type reclaims what is under it, so a keystroke
	// inside a deleted block has no parent to come back to. This is the honest
	// limit of "in place": the node survives, and the text a peer typed into
	// the old blocks does not.
	expect(bodyOf(a)).toBe('replaced');
	expect(bodyOf(b)).toBe('replaced');
});

test('a peer adding a NEW block survives, because its parent was not deleted', () => {
	const a = new Y.Doc();
	const b = new Y.Doc();
	rewrite(a.get('body'), ['hello']);
	sync(a, b);

	b.get('body').insert(1, [block('a thought of my own')]);
	rewrite(a.get('body'), ['replaced']);
	sync(a, b);

	// It lands beside the new body rather than being discarded. Nothing here
	// can order it against text it never saw, which is why a person is told
	// the note's text moved on both sides before they answer.
	expect(bodyOf(a)).toBe(bodyOf(b));
	expect(bodyOf(a)).toContain('a thought of my own');
	expect(bodyOf(a)).toContain('replaced');
});
