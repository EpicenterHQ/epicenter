/**
 * How a contract's folder is stored in Git, one rule for every writer: the
 * server's receiver and translator, and `epicenter init` on a desktop.
 *
 * - A note is a path ending in `.md`, in any case (`a.MD` is a note too):
 *   one predicate, `isNotePath`, for templates, the server and sync, since
 *   a Mac checkout (`core.ignorecase`) reads `*.md` that way anyway.
 * - A hidden path (any segment starting with `.`: `.gitattributes`,
 *   `.DS_Store`, `.epicenter/…`) is outside the contract (decision 58):
 *   `checkContract` skips it, and it is stored as it is.
 * - Every other file that is not a `.md` note is a Git LFS pointer
 *   (decision 40), whatever a folder's own `.gitattributes` says.
 *
 * `REPOSITORY_ATTRIBUTES` is that rule as Git reads it (decision 59). The
 * server writes it as the whole `.gitattributes` in the first commit of a
 * repository it creates; `epicenter init` keeps it as a marked block among a
 * person's own lines, and finds the server's copy by the same markers. Later
 * lines win per attribute, so its order matters. Notes merge with the
 * Epicenter merge driver (`merge=epicenter`). Git matches attribute
 * patterns case-sensitively unless `core.ignorecase` is set, so the note
 * line spells out both cases (`*.[mM][dD]`) to agree with `isNotePath`
 * everywhere.
 */

/** Whether a path names a note: a Markdown file, `.md` in any case. Anything else is a file (decision 3). */
export const isNotePath = (path: string) => /\.md$/i.test(path);

/** Whether `path` has a hidden segment, and so is outside the contract. */
export const isHiddenPath = (path: string) =>
	path.split('/').some((segment) => segment.startsWith('.'));

/** Whether `path` is stored as a Git LFS pointer: not hidden, and not a note. */
export const storedWithLfs = (path: string) =>
	!isHiddenPath(path) && !isNotePath(path);

/** The line that opens `REPOSITORY_ATTRIBUTES`, matched as a prefix. */
export const REPOSITORY_ATTRIBUTES_BEGIN = '# BEGIN epicenter';
/** The line that closes `REPOSITORY_ATTRIBUTES`. */
export const REPOSITORY_ATTRIBUTES_END = '# END epicenter';

export const REPOSITORY_ATTRIBUTES = `${REPOSITORY_ATTRIBUTES_BEGIN} (managed by Epicenter; edit outside this block)
# Notes merge by Epicenter's rules; every other file except hidden paths is Git LFS.
* filter=lfs diff=lfs merge=lfs -text
*.[mM][dD] !filter !diff merge=epicenter text
.* !filter !diff !merge !text
.*/** !filter !diff !merge !text
**/.*/** !filter !diff !merge !text
${REPOSITORY_ATTRIBUTES_END}
`;
