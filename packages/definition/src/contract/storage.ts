/**
 * How a contract's folder is stored in Git, one rule for every writer: the
 * server's receiver and translator, and `epicenter init` on a desktop.
 *
 * - A hidden path (any segment starting with `.`: `.gitattributes`,
 *   `.DS_Store`, `.epicenter/…`) is outside the contract (decision 58):
 *   `checkContract` skips it, and it is stored as it is.
 * - Every other file that is not a `.md` note is a Git LFS pointer
 *   (decision 40), whatever a folder's own `.gitattributes` says.
 *
 * `REPOSITORY_ATTRIBUTES` is that rule as Git reads it: the `.gitattributes`
 * that `epicenter init` commits and the server writes in the first commit of
 * a repository it creates (decision 59). Notes merge with the Epicenter
 * merge driver (`merge=epicenter`).
 */
import { isNotePath } from './templates.js';

/** Whether `path` has a hidden segment, and so is outside the contract. */
export const isHiddenPath = (path: string) =>
	path.split('/').some((segment) => segment.startsWith('.'));

/** Whether `path` is stored as a Git LFS pointer: not hidden, and not a note. */
export const storedWithLfs = (path: string) =>
	!isHiddenPath(path) && !isNotePath(path);

export const REPOSITORY_ATTRIBUTES = `# Managed by Epicenter. Notes merge by Epicenter rules; every other file is Git LFS; hidden paths are left alone.
* filter=lfs diff=lfs merge=lfs -text
*.md !filter !diff merge=epicenter text
.* !filter !diff !merge !text
.*/** !filter !diff !merge !text
**/.*/** !filter !diff !merge !text
`;
