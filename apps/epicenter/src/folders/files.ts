/**
 * How a folder editor window shows its folder's files and edits one exactly:
 * the tree a listing of paths shows (`fileTree`) and which files the editor can change as text (`fileText`).
 *
 * The editor opens its window's folder with no tables (`tables: {}`).
 * Files edits each source as text. Tables separately interprets Markdown
 * through optional declarations on the same open handle. A file that is not UTF-8 text, or whose line endings a
 * text box would rewrite, is shown and left as it is.
 */

/** One line of the tree: a directory, or a file to open. */
export type TreeRow = {
	readonly kind: 'directory' | 'file';
	readonly path: string;
	readonly name: string;
	readonly depth: number;
};

const byName = (a: string, b: string) =>
	a.localeCompare(b, undefined, { sensitivity: 'base', numeric: true }) ||
	(a < b ? -1 : a > b ? 1 : 0);

const nameOf = (path: string) => path.slice(path.lastIndexOf('/') + 1);
const parentOf = (path: string) =>
	path.slice(0, Math.max(path.lastIndexOf('/'), 0));

/**
 * The rows a tree of `paths` shows, every directory expanded: directories
 * before files at each level, each by name. A directory is shown when a
 * file is below it; the folder lists files, not empty directories.
 */
export function fileTree(paths: readonly string[]): TreeRow[] {
	const children = new Map<string, Set<string>>([['', new Set()]]);
	const files = new Set<string>();
	const childrenOf = (directory: string) => {
		let set = children.get(directory);
		if (set === undefined) {
			set = new Set();
			children.set(directory, set);
		}
		return set;
	};
	for (const path of paths) {
		files.add(path);
		let child = path;
		let parent = parentOf(child);
		childrenOf(parent).add(child);
		while (parent !== '' && !childrenOf(parentOf(parent)).has(parent)) {
			child = parent;
			parent = parentOf(child);
			childrenOf(parent).add(child);
		}
	}
	const rows: TreeRow[] = [];
	function walk(directory: string, depth: number) {
		const entries = [...(children.get(directory) ?? [])];
		const directories = entries
			.filter((path) => children.has(path) && !files.has(path))
			.sort((a, b) => byName(nameOf(a), nameOf(b)));
		const leaves = entries
			.filter((path) => files.has(path))
			.sort((a, b) => byName(nameOf(a), nameOf(b)));
		for (const path of directories) {
			rows.push({ kind: 'directory', path, name: nameOf(path), depth });
			walk(path, depth + 1);
		}
		for (const path of leaves)
			rows.push({ kind: 'file', path, name: nameOf(path), depth });
	}
	walk('', 0);
	return rows;
}

/** What one file is to the editor. */
export type FileText =
	/** Valid UTF-8 with line endings a textarea can preserve. */
	| { readonly kind: 'text' }
	/** Text whose line endings mix `\r\n` with `\n` or `\r`; a text box would rewrite them. */
	| { readonly kind: 'mixed'; readonly text: string }
	/** Not UTF-8 text, or text with a NUL byte. */
	| { readonly kind: 'binary'; readonly size: number };

const decoder = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true });

/** Whether `bytes` can be edited, or what to show when they cannot. */
export function fileText(bytes: Uint8Array): FileText {
	let text: string;
	try {
		text = decoder.decode(bytes);
	} catch {
		return { kind: 'binary', size: bytes.length };
	}
	if (text.includes('\0')) return { kind: 'binary', size: bytes.length };
	const crlf = (text.match(/\r\n/g) ?? []).length;
	const cr = (text.match(/\r/g) ?? []).length;
	const lf = (text.match(/\n/g) ?? []).length;
	// Every `\r` begins a `\r\n`, and every `\n` ends one, or neither occurs.
	if (cr === crlf && (crlf === 0 || lf === crlf)) return { kind: 'text' };
	return { kind: 'mixed', text };
}
