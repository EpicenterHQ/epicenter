/**
 * How a repository stores a contract's files, in one place for the server
 * and `epicenter init` (decisions 40, 58, 59): every file is a Git LFS
 * pointer except `.md` notes, which merge by Epicenter's rules, and hidden
 * paths (any segment that starts with `.`), which are outside the contract.
 *
 * `ATTRIBUTES` is the `.gitattributes` block that says so. The server writes
 * it as the whole file in the first commit of a repository it creates;
 * `epicenter init` keeps it as a marked block among a person's own lines.
 * Later lines win per attribute, so its order matters. `storedAsPointer` is
 * the same rule as a predicate, for the receiver to check pushed trees.
 */

export const ATTRIBUTES_BEGIN = '# BEGIN epicenter';
export const ATTRIBUTES_END = '# END epicenter';

export const ATTRIBUTES = `${ATTRIBUTES_BEGIN} (managed by epicenter init; edit outside this block)
# Notes merge by Epicenter's rules; every other file except hidden paths is Git LFS.
* filter=lfs diff=lfs merge=lfs -text
*.md !filter !diff merge=epicenter text
.* !filter !diff !merge !text
.*/** !filter !diff !merge !text
**/.*/** !filter !diff !merge !text
${ATTRIBUTES_END}
`;

/** Whether the file at `path` (repository-relative, `/`-separated) must be stored as an LFS pointer. */
export const storedAsPointer = (path: string) =>
	!path.split('/').some((segment) => segment.startsWith('.')) &&
	!path.endsWith('.md');
