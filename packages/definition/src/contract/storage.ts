/**
 * How a contract's folder is stored in Git, one rule for every writer: the
 * server's receiver and translator, and `epicenter init` on a desktop.
 *
 * - A note is a path ending in `.md`, in any case (`a.MD` is a note too):
 *   one predicate, `isNotePath`, for templates, the server and sync, since
 *   a Mac checkout (`core.ignorecase`) reads `*.md` that way anyway.
 * - A hidden path (any segment starting with `.`: `.gitattributes`,
 *   `.DS_Store`, a folder's unfinished writes) is outside the contract
 *   (decision 58): `checkContract` skips it, no watcher reports it, and it
 *   is stored as it is.
 * - The folder's `epicenter.json`, its contract and title (ADR-0811), is
 *   stored as it is, so the server reads the title from the tree and a plain
 *   clone holds readable JSON.
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
 *
 * Init's marked block of `.gitignore` (`REPOSITORY_IGNORE` in the CLI)
 * sits between the same markers.
 */

/** Whether a path names a note: a Markdown file, `.md` in any case. Anything else is a file (decision 3). */
export const isNotePath = (path: string) => /\.md$/i.test(path);

/** Whether `path` has a hidden segment, and so is outside the contract. */
export const isHiddenPath = (path: string) =>
	path.split('/').some((segment) => segment.startsWith('.'));

/** The folder's contract, at its root, stored as it is. */
export const CONTRACT_PATH = 'epicenter.json';

/** Whether `path` is stored as a Git LFS pointer: not hidden, not a note, and not the folder's contract. */
export const storedWithLfs = (path: string) =>
	!isHiddenPath(path) && !isNotePath(path) && path !== CONTRACT_PATH;

/** The line that opens a block Epicenter manages (`REPOSITORY_ATTRIBUTES`, and init's `.gitignore` block), matched as a prefix. */
export const EPICENTER_BLOCK_BEGIN = '# BEGIN epicenter';
/** The line that closes a block Epicenter manages. */
export const EPICENTER_BLOCK_END = '# END epicenter';

export const REPOSITORY_ATTRIBUTES = `${EPICENTER_BLOCK_BEGIN} (managed by Epicenter; edit outside this block)
# Notes merge by Epicenter's rules; every other file except hidden paths and the contract is Git LFS.
* filter=lfs diff=lfs merge=lfs -text
*.[mM][dD] !filter !diff merge=epicenter text
/epicenter.json !filter !diff !merge text
.* !filter !diff !merge !text
.*/** !filter !diff !merge !text
**/.*/** !filter !diff !merge !text
${EPICENTER_BLOCK_END}
`;
