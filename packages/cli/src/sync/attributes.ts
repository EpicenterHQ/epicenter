/**
 * The block of `.gitattributes` that `epicenter init` owns in a data folder
 * (decision 40): every file is Git LFS except `.md` notes, which merge by
 * Epicenter's rules, and dotfiles and anything under a dot directory, such
 * as `.gitattributes` itself, `.gitignore`, or `.obsidian/`. The server's
 * pointer rule is the same predicate: a path with a segment that starts
 * with `.` is exempt, and otherwise every path not ending in `.md` must be
 * a pointer.
 *
 * Later lines win per attribute, so the block's own order matters, and a
 * person's lines after the block can still narrow it on purpose. Lines
 * outside the block are never changed.
 */

const BEGIN = '# BEGIN epicenter';
const END = '# END epicenter';

export const ATTRIBUTES_BLOCK = `${BEGIN} (managed by epicenter init; edit outside this block)
# Notes merge by Epicenter's rules; every other file except dotfiles is Git LFS.
* filter=lfs diff=lfs merge=lfs -text
*.md !filter !diff merge=epicenter text
.* !filter !diff !merge !text
.*/** !filter !diff !merge !text
**/.*/** !filter !diff !merge !text
${END}
`;

/**
 * `current` (null when there is no file) with Epicenter's block in it:
 * replaced in place where a block already stands, and otherwise appended,
 * so that it overrides the person's earlier lines.
 */
export function withAttributesBlock(current: string | null): string {
	if (current === null || current === '') return ATTRIBUTES_BLOCK;
	const start = current.indexOf(`${BEGIN}`);
	const end = current.indexOf(`${END}\n`, start);
	if (start !== -1 && end !== -1)
		return `${current.slice(0, start)}${ATTRIBUTES_BLOCK}${current.slice(end + END.length + 1)}`;
	return `${current.endsWith('\n') ? current : `${current}\n`}${ATTRIBUTES_BLOCK}`;
}
