/** Synthetic plain-text corpus shared by the root replacement experiment and its tests. */
import * as Y from '@y/y';
import {
	createRow,
	readRow,
	readRowBody,
	tableRoot,
} from '../store/document.js';

export const encode = Y.encodeStateAsUpdateV2;

export function reopen(update: Uint8Array): Y.Doc {
	const doc = new Y.Doc({ gc: true });
	Y.applyUpdateV2(doc, update);
	return doc;
}

export function rows(doc: Y.Doc, wrapped = true): Y.Node {
	if (!wrapped) return tableRoot(doc, 'notes');
	return doc.get('application').getAttr('data' as never) as Y.Node;
}

export function seed(wrapped = true): Y.Doc {
	const doc = new Y.Doc({ gc: true });
	doc.transact(() => {
		if (wrapped)
			doc.get('application').setAttr('data' as never, new Y.Node() as never);
		for (let i = 0; i < 100; i++)
			put(rows(doc, wrapped), `live-${i}`, `Note ${i}`);
	});
	return doc;
}

export function put(root: Y.Node, id: string, title: string): void {
	const content = new Y.Node();
	content.insert(0, ['x'.repeat(128)]);
	createRow(root, id, { title, ordinal: 42 }, content);
}

export function visible(doc: Y.Doc, wrapped = true) {
	const root = rows(doc, wrapped);
	return [...root.attrKeys()]
		.map(String)
		.sort()
		.map((id) => ({
			id,
			fields: readRow(root, id)!,
			text: readRowBody(root, id)!.toString(),
		}));
}

/** Copies this fixture's value fields and plain text, not arbitrary rich content. */
export function reconstruct(source: Y.Doc, fresh = false): Y.Doc {
	const saved = visible(source);
	const target = fresh ? new Y.Doc({ gc: true }) : source;
	target.transact(() => {
		const root = new Y.Node();
		target.get('application').setAttr('data' as never, root as never);
		for (const { id, fields, text } of saved) {
			const content = new Y.Node();
			if (text) content.insert(0, [text]);
			createRow(root, id, { ...fields }, content);
		}
	});
	return target;
}
