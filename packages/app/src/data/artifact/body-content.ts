import * as Y from '@y/y';
import type { DeltaAny } from 'lib0/delta';

import type { BodyCodec } from '../definition/index.js';

/** Decode complete sequence content before entering a store transaction. */
export function decodeBody(codec: BodyCodec, text: string): DeltaAny {
	const content = codec.decode(text);
	const snapshot = content.toJSON();
	if (snapshot.attrs && Object.keys(snapshot.attrs).length > 0) {
		throw new Error('A body codec may not edit body-root attributes');
	}
	if (
		snapshot.children?.some(
			(operation) => !('type' in operation) || operation.type !== 'insert',
		)
	) {
		throw new Error('A body codec must return insertion-only content');
	}
	return content;
}

/** Replace only the sequence; the live body and its root attributes survive. */
export function replaceBody(node: Y.Node, content: DeltaAny): void {
	if (node.length > 0) node.delete(0, node.length);
	node.applyDelta(content);
}
