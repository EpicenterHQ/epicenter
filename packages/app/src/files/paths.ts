/**
 * Literal folder-relative paths and the row/attachment naming rules.
 *
 * Paths are never normalized, case folded, or aliased. A path that would need
 * rewriting to be usable is refused so that raw access and Git history address
 * exactly the bytes a person or agent sees.
 */

/** Path segments that are never portable source. `.git` holds private Git state. */
const PRIVATE_SEGMENTS = new Set(['.git']);
/** Operating-system scratch files that commits and status never include. */
const SCRATCH_NAMES = new Set(['.DS_Store']);
/** The root generated query index; derived data, never history source. */
export const GENERATED_INDEX = 'index.sqlite3';

// biome-ignore lint/suspicious/noControlCharactersInRegex: control characters are what this rejects.
const CONTROL = /[\u0000-\u001f\u007f]/;

/**
 * Why a literal path is unusable, or `undefined` when it is a valid
 * folder-relative path: nonempty `/`-separated segments, no `.` or `..`, no
 * leading slash, backslash, or control character.
 */
export function pathProblem(path: string): string | undefined {
	if (path === '') return 'the path is empty';
	if (path.startsWith('/')) return 'the path must be folder-relative';
	if (path.includes('\\')) return 'the path contains a backslash';
	if (CONTROL.test(path)) return 'the path contains a control character';
	for (const segment of path.split('/')) {
		if (segment === '') return 'the path contains an empty segment';
		if (segment === '.' || segment === '..')
			return 'the path contains a relative segment';
		// Git refuses `.git` at any depth, in any case, as a tracked path.
		if (PRIVATE_SEGMENTS.has(segment.toLowerCase()))
			return 'the path is inside private Git state';
	}
	return undefined;
}

/**
 * Candidate history source: every valid path except operating-system scratch
 * files and the root generated index. `.gitignore` narrows it further in
 * `git/scope.ts`.
 */
export function isPortablePath(path: string): boolean {
	if (pathProblem(path) !== undefined) return false;
	if (path === GENERATED_INDEX) return false;
	return !SCRATCH_NAMES.has(basename(path));
}

export function basename(path: string): string {
	const slash = path.lastIndexOf('/');
	return slash < 0 ? path : path.slice(slash + 1);
}

export function dirname(path: string): string {
	const slash = path.lastIndexOf('/');
	return slash < 0 ? '' : path.slice(0, slash);
}

/** Every proper ancestor directory of a path, nearest last. */
export function ancestors(path: string): string[] {
	const parts = path.split('/');
	const result: string[] = [];
	for (let index = 1; index < parts.length; index++)
		result.push(parts.slice(0, index).join('/'));
	return result;
}

export const ROW_EXTENSION = '.md';

/**
 * Why a stem cannot name a row file, or `undefined` when it can. A stem is a
 * single path segment; it may contain dots, since the row adds `.md`.
 */
export function stemProblem(stem: string): string | undefined {
	if (stem === '') return 'the stem is empty';
	if (stem.includes('/') || stem.includes('\\'))
		return 'the stem contains a path separator';
	if (CONTROL.test(stem)) return 'the stem contains a control character';
	if (stem === '.' || stem === '..') return 'the stem is a relative segment';
	if (stem.startsWith('.')) return 'the stem starts with a dot';
	if (/[ .]$/.test(stem)) return 'the stem ends with a space or dot';
	if (/[<>:"|?*]/.test(stem))
		return 'the stem contains a character some filesystems refuse';
	if (new TextEncoder().encode(`${stem}.md`).byteLength > 255)
		return 'the filename is too long';
	return undefined;
}

export function rowPath(table: string, stem: string): string {
	return `${table}/${stem}${ROW_EXTENSION}`;
}

/** The row stem of a table file, or `undefined` when the file is not a row. */
export function rowStemOf(table: string, path: string): string | undefined {
	const prefix = `${table}/`;
	if (!path.startsWith(prefix)) return undefined;
	const filename = path.slice(prefix.length);
	if (filename.includes('/')) return undefined;
	if (!filename.endsWith(ROW_EXTENSION)) return undefined;
	return filename.slice(0, -ROW_EXTENSION.length);
}

/**
 * The owning stem of a same-directory attachment candidate: the filename
 * split at its final dot, where the extension is one nonempty ASCII
 * alphanumeric segment other than `md` in any case (ADR-0456).
 */
export function attachmentStemOf(filename: string): string | undefined {
	const dot = filename.lastIndexOf('.');
	if (dot <= 0) return undefined;
	const extension = filename.slice(dot + 1);
	if (!/^[A-Za-z0-9]+$/.test(extension)) return undefined;
	if (extension.toLowerCase() === 'md') return undefined;
	return filename.slice(0, dot);
}

export function isAttachmentExtension(extension: string): boolean {
	return /^[A-Za-z0-9]+$/.test(extension) && extension.toLowerCase() !== 'md';
}

/**
 * Case- and Unicode-folded spelling used only to detect destinations that
 * cannot coexist on case-insensitive filesystems. Never used for lookup.
 */
export function collisionKey(path: string): string {
	return path.normalize('NFC').toLowerCase();
}
