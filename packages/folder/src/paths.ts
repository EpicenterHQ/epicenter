/**
 * Literal folder-relative paths and row addresses.
 *
 * Paths are never normalized, case folded, or aliased. A path that would need
 * rewriting to be usable is refused so that raw access and Git history address
 * exactly the bytes a person or agent sees.
 */

/** Path segments that are never portable source. `.git` holds private Git state. */
const PRIVATE_SEGMENTS = new Set(['.git']);
/** Operating-system scratch files that commits and status never include. */
const SCRATCH_NAMES = new Set(['.DS_Store']);

/** C0 controls, DEL, and C1 controls: what Rust's `char::is_control` covers. */
// biome-ignore lint/suspicious/noControlCharactersInRegex: control characters are what this rejects.
const CONTROL = /[\u0000-\u001f\u007f-\u009f]/;

/** Characters Windows refuses in a name. */
const RESERVED = /[<>:"|?*]/;
/**
 * Code points HFS+ ignores when it compares names, or that Unicode marks
 * default-ignorable: a name holding one can resolve to a name without it.
 */
const IGNORABLE =
	// biome-ignore lint/suspicious/noMisleadingCharacterClass: each combining mark is escaped and matched alone, which is the point.
	/[\u00AD\u034F\u061C\u115F\u1160\u17B4\u17B5\u180B-\u180F\u200B-\u200F\u202A-\u202E\u2060-\u206F\u3164\uFE00-\uFE0F\uFEFF\uFFA0\uFFF0-\uFFF8\u{1BCA0}-\u{1BCA3}\u{1D173}-\u{1D17A}\u{E0000}-\u{E0FFF}]/u;
/**
 * A Windows 8.3 short name such as `GIT~1` or `NOTES~12.MD`, which can name
 * another entry, `.git` itself among them: a stem of one to six characters
 * without a space or dot, `~` and digits, then optionally a dot and an
 * extension of one to three characters without a space or dot. `Notes ~2.md`
 * and `version~2-final.md` are not this shape.
 */
const SHORT_NAME = /^[^ .]{1,6}~[0-9]+(\.[^ .]{1,3})?$/u;

/**
 * A name Windows reserves for a device, with or without an extension: the
 * part before the first dot, without trailing spaces (` `, U+0020 only), is a
 * device name in any case. Windows drops trailing dots too, but the part
 * before the first dot holds none.
 */
function isDeviceName(segment: string): boolean {
	const stem = (segment.split('.')[0] ?? '').replace(/ +$/, '').toUpperCase();
	return /^(CON|PRN|AUX|NUL|CONIN\$|CONOUT\$|(COM|LPT)[0-9¹²³])$/.test(stem);
}

/**
 * Whether `segment` means only itself on every disk a folder can live on. A
 * name Windows rewrites (a trailing dot or space, a reserved character, a
 * device name, a short name) or that HFS+ compares without an ignorable
 * character could resolve to another entry, `.git` among them.
 */
function namesOnlyItself(segment: string): boolean {
	return (
		!/[. ]$/.test(segment) &&
		!RESERVED.test(segment) &&
		!IGNORABLE.test(segment) &&
		!isDeviceName(segment) &&
		!SHORT_NAME.test(segment)
	);
}

/**
 * Why a literal path is unusable, or `undefined` when it is a valid
 * folder-relative path: nonempty `/`-separated segments, no `.` or `..`, no
 * leading slash, backslash, or control character; no segment that is `.git`
 * or `HEAD` in any case, so no path reaches Git's private state or assembles
 * a repository; and every segment a name that means only itself on every disk
 * (`namesOnlyItself`). Leading dots are ordinary. The Rust shell applies the
 * same rule (`paths.rs`); `fixtures/path-rules.json` holds both to it.
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
		if (segment.toUpperCase() === 'HEAD')
			return 'the path contains a segment named HEAD, which Git reads as a repository';
		if (!namesOnlyItself(segment))
			return `the name '${segment}' can name another file on some disks`;
	}
	return undefined;
}

/**
 * Candidate history source: every valid path except operating-system scratch
 * files. `.gitignore` narrows it further in `git/scope.ts`.
 */
export function isPortablePath(path: string): boolean {
	if (pathProblem(path) !== undefined) return false;
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
 * The row file a literal stem names. The stem is used as written: nothing is
 * trimmed, folded, or stripped. Whether it addresses a row at all is
 * `rowAddressProblem`'s question.
 */
export function rowPath(table: string, stem: string): string {
	return `${table}/${stem}${ROW_EXTENSION}`;
}

/**
 * The row id a file name directly in a table's directory carries, or
 * `undefined` when the name is not a row's. This is the one row predicate
 * every entry point shares: listing, a row's get, set, delete, and rename,
 * `epicenter check` and `epicenter query`, and change events. A row's file
 * name is a nonempty id that does not start with a dot, then exactly the
 * lowercase `.md`; the id is the name without `.md`. So `.md`, `.hidden.md`,
 * `.epicenter.json`, and `a.MD` are never rows. (Whether the entry is a
 * regular file is the storage's to say: a listing never offers a directory
 * as a row, and a read refuses anything else that is not a file.)
 */
export function rowStemOfName(filename: string): string | undefined {
	if (filename.includes('/')) return undefined;
	if (!filename.endsWith(ROW_EXTENSION)) return undefined;
	const stem = filename.slice(0, -ROW_EXTENSION.length);
	if (stem === '' || stem.startsWith('.')) return undefined;
	return stem;
}

/**
 * Why a stem does not address a row of the table, or `undefined` when it
 * does: exactly when `rowStemOfName` reads the stem back from its file name,
 * and that file's path passes the folder's own path rules (`pathProblem`).
 * A row file's name must mean only itself on every disk a folder can live
 * on, so a stem like `a: b` or `con` is refused, and so are the empty stem
 * and one that starts with a dot. A stem ending in a space is ordinary,
 * since its file name still ends in `.md`.
 */
export function rowAddressProblem(
	table: string,
	stem: string,
): string | undefined {
	if (typeof stem !== 'string') return 'the stem is not a string';
	if (stem.includes('/')) return 'the stem contains a path separator';
	if (stem === '') return 'the stem is empty';
	if (stem.startsWith('.'))
		return 'the stem starts with a dot, and a dot file is never a row';
	return pathProblem(rowPath(table, stem));
}

/**
 * The inverse of `rowPath`: the id of a row file directly in the table's
 * directory (`rowStemOfName`), or `undefined` when the path is not a row of
 * that table.
 */
export function rowStemOf(table: string, path: string): string | undefined {
	const prefix = `${table}/`;
	if (!path.startsWith(prefix)) return undefined;
	return rowStemOfName(path.slice(prefix.length));
}

/**
 * The file in a table's directory that holds its schema, and makes the
 * directory a table: `<table>/.epicenter.json`. A folder's tables are its
 * top-level directories that hold one; nothing else declares a table.
 */
export const SCHEMA_FILE = '.epicenter.json';

/** Where the table `table` keeps its schema. */
export function schemaPath(table: string): string {
	return `${table}/${SCHEMA_FILE}`;
}

/**
 * The table whose schema `path` is, `<table>/.epicenter.json` with `<table>`
 * one top-level directory, or `undefined` for any other path.
 */
export function tableOfSchemaPath(path: string): string | undefined {
	const slash = path.indexOf('/');
	if (slash <= 0) return undefined;
	const table = path.slice(0, slash);
	return path === schemaPath(table) ? table : undefined;
}

/**
 * Case- and Unicode-folded spelling Sync compares names by, to refuse a tree
 * whose paths some filesystem could not hold apart and a file that stands
 * under another spelling (ADR-0474, ADR-0576). Never used for lookup, and
 * never applied to a local save: a create or rename is refused by what its
 * own filesystem does.
 *
 * Lowercased, uppercased, and lowercased again, so names APFS holds as one
 * meet: `ς` and `σ`, `ß` and `ss`, `ﬀ` and `ff`, `ſ` and `s`, `µ` and `μ`.
 * It also joins `ı` and `i`, which APFS keeps apart; that only refuses a
 * Sync, never merges two files.
 */
export function collisionKey(path: string): string {
	return path
		.normalize('NFC')
		.toLowerCase()
		.toUpperCase()
		.toLowerCase()
		.normalize('NFC');
}
