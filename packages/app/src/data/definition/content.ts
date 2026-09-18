/**
 * The one content codec the platform can ship.
 *
 * A table's content codec says what its node MEANS, and the platform cannot
 * know that: `notes` holds rich text bound to a ProseMirror schema, `skills`
 * holds a plain line of text, and `conversations` holds a keyed log with
 * nothing in its sequence at all. Only the declaring package can say which.
 *
 * What the platform can ship is the case where the node IS its text and
 * nothing else, which is common enough to be worth having once.
 */
import * as Y from '@y/y';
import { Ok, type Result } from 'wellcrafted/result';

import type { ContentCodec, ContentError } from './declaration.js';

/**
 * A content node that is its sequence, read and written as one string.
 *
 * `decode` inserts in ONE call rather than appending in a loop. A detached
 * node replays one positional delta when `create` integrates it; a loop of
 * appends silently reverses (`evidence/detached-type.test.ts`).
 *
 * `rewrite` clears the sequence and refills it, on the node the row already
 * holds. Whole rather than diffed, because this codec's content IS one string
 * and there is nothing else in the node to preserve: the attributes it never
 * writes are left exactly where they are, so an application that grows one
 * later does not lose it to a body edit.
 *
 * Neither can fail. Any text is a valid node here, which is what makes this
 * the codec for a table whose content is exactly its text, and what makes it
 * the WRONG codec for a table whose node carries attributes: `toString` would
 * render them, `insert` would take the rendering back as one literal string,
 * and the two would print identically while the structure was gone.
 */
export function plainText(): ContentCodec {
	return {
		encode: (node) => node.toString(),
		decode: (text): Result<Y.Type, ContentError> => {
			const node = new Y.Type();
			if (text !== '') node.insert(0, [text]);
			return Ok(node);
		},
		rewrite: (node, text): Result<void, ContentError> => {
			if (node.length > 0) node.delete(0, node.length);
			if (text !== '') node.insert(0, [text]);
			return Ok(undefined);
		},
	};
}
