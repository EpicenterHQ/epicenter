/** Plain-text file conversion for a body whose sequence is its text. */
import * as delta from 'lib0/delta';

import type { BodyCodec } from './declaration.js';

/** Every string is valid content; decoding produces one insertion delta. */
export function plainText(): BodyCodec {
	return {
		encode: (node) => node.toString(),
		decode: (text) => text === '' ? delta.create().done() : delta.create().insert(text).done(),
	};
}
