/**
 * The blocks of a data folder's committed `.gitattributes` and `.gitignore`
 * that `epicenter init` owns: `REPOSITORY_ATTRIBUTES` (the text the server
 * also writes; decisions 40, 58, 59) and `REPOSITORY_IGNORE`, from
 * `@epicenter/definition/contract`, each between the same markers. A
 * person's lines after a block can still narrow it on purpose; lines
 * outside the block are never changed.
 */

import {
	EPICENTER_BLOCK_BEGIN,
	EPICENTER_BLOCK_END,
} from '@epicenter/definition/contract';

/**
 * `current` (null when there is no file) with Epicenter's `block` in it:
 * replaced in place where a block already stands, and otherwise appended,
 * so that it overrides the person's earlier lines.
 */
export function withEpicenterBlock(
	current: string | null,
	block: string,
): string {
	if (current === null || current === '') return block;
	const start = current.indexOf(EPICENTER_BLOCK_BEGIN);
	const end = current.indexOf(`${EPICENTER_BLOCK_END}\n`, start);
	if (start !== -1 && end !== -1)
		return `${current.slice(0, start)}${block}${current.slice(end + EPICENTER_BLOCK_END.length + 1)}`;
	return `${current.endsWith('\n') ? current : `${current}\n`}${block}`;
}
