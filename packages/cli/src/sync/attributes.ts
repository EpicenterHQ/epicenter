/**
 * The block of `.gitattributes` that `epicenter init` owns in a data folder:
 * `ATTRIBUTES` from `@epicenter/definition/merge`, the text the server also
 * writes (decisions 40, 58, 59). Every file is Git LFS except `.md` notes
 * and hidden paths. A person's lines after the block can still narrow it on
 * purpose; lines outside the block are never changed.
 */

import {
	ATTRIBUTES,
	ATTRIBUTES_BEGIN,
	ATTRIBUTES_END,
} from '@epicenter/definition/merge';


/**
 * `current` (null when there is no file) with Epicenter's block in it:
 * replaced in place where a block already stands, and otherwise appended,
 * so that it overrides the person's earlier lines.
 */
export function withAttributesBlock(current: string | null): string {
	if (current === null || current === '') return ATTRIBUTES;
	const start = current.indexOf(ATTRIBUTES_BEGIN);
	const end = current.indexOf(`${ATTRIBUTES_END}\n`, start);
	if (start !== -1 && end !== -1)
		return `${current.slice(0, start)}${ATTRIBUTES}${current.slice(end + ATTRIBUTES_END.length + 1)}`;
	return `${current.endsWith('\n') ? current : `${current}\n`}${ATTRIBUTES}`;
}
