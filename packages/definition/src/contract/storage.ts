/**
 * How a folder's paths are read, one rule for every surface: templates,
 * the server, sync, and the export.
 *
 * - A note is a path ending in `.md`, in any case (`a.MD` is a note too):
 *   one predicate, `isNotePath`, for templates, the merge, and the export,
 *   since a Mac (`core.ignorecase`) reads `*.md` that way anyway. A note
 *   merges by Epicenter's rules; every other file is kept whole, the later
 *   write winning (ADR-0795).
 * - A hidden path (any segment starting with `.`: `.DS_Store`, a folder's
 *   unfinished writes) is outside the contract (decision 58):
 *   `checkContract` skips it, no watcher reports it, and sync leaves it.
 * - The folder's `epicenter.json` is its contract and title (ADR-0811).
 *
 * How bytes are stored never depends on the path: a version is the SHA-256
 * of a file's bytes, kept inline or in the blob store by size (ADR-0824).
 */

/** Whether a path names a note: a Markdown file, `.md` in any case. Anything else is a file (decision 3). */
export const isNotePath = (path: string) => /\.md$/i.test(path);

/** Whether `path` has a hidden segment, and so is outside the contract. */
export const isHiddenPath = (path: string) =>
	path.split('/').some((segment) => segment.startsWith('.'));

/** The folder's contract, at its root. */
export const CONTRACT_PATH = 'epicenter.json';
