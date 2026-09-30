/**
 * What the file browser shows of a folder listing, and how a raw file is read
 * for editing. Paths are the folder's literal paths; nothing here writes.
 */
import {
	type FileError,
	type FileListing,
	type FileVersion,
	type FolderFiles,
	pathProblem,
} from '@epicenter/app/files';
import { Ok, type Result } from 'wellcrafted/result';

export type TreeRow = {
	readonly path: string;
	readonly name: string;
	readonly depth: number;
} & (
	| { readonly kind: 'directory'; readonly children: number }
	| { readonly kind: 'file'; readonly size: number }
);

export function basename(path: string): string {
	return path.slice(path.lastIndexOf('/') + 1);
}

export function dirname(path: string): string {
	const slash = path.lastIndexOf('/');
	return slash < 0 ? '' : path.slice(0, slash);
}

export function joinPath(directory: string, name: string): string {
	return directory === '' ? name : `${directory}/${name}`;
}

/** Every proper ancestor directory of a path, outermost first. */
export function ancestorsOf(path: string): string[] {
	const parts = path.split('/');
	return parts.slice(1).map((_, index) => parts.slice(0, index + 1).join('/'));
}

const byName = (a: string, b: string) =>
	a.localeCompare(b, undefined, { sensitivity: 'base', numeric: true }) ||
	(a < b ? -1 : a > b ? 1 : 0);

/**
 * The rows a tree shows: folders before files at each level, descending only
 * into expanded folders. Private Git state is never listed as source.
 */
export function visibleRows(
	listing: FileListing,
	expanded: ReadonlySet<string>,
): TreeRow[] {
	const directories = new Map<string, string[]>([['', []]]);
	const files = new Map<string, number>();
	const childrenOf = (directory: string) => {
		let list = directories.get(directory);
		if (list === undefined) {
			list = [];
			directories.set(directory, list);
		}
		return list;
	};
	const visible = (path: string) => path.split('/')[0] !== '.git';
	for (const directory of listing.directories) {
		if (!visible(directory)) continue;
		childrenOf(directory);
		childrenOf(dirname(directory)).push(directory);
	}
	for (const file of listing.files) {
		if (!visible(file.path)) continue;
		files.set(file.path, file.size);
		childrenOf(dirname(file.path)).push(file.path);
	}

	const rows: TreeRow[] = [];
	function walk(directory: string, depth: number) {
		const children = [...new Set(directories.get(directory))];
		const folders = children
			.filter((path) => directories.has(path))
			.sort((a, b) => byName(basename(a), basename(b)));
		const leaves = children
			.filter((path) => !directories.has(path))
			.sort((a, b) => byName(basename(a), basename(b)));
		for (const path of folders) {
			rows.push({
				kind: 'directory',
				path,
				name: basename(path),
				depth,
				children: new Set(directories.get(path)).size,
			});
			if (expanded.has(path)) walk(path, depth + 1);
		}
		for (const path of leaves)
			rows.push({
				kind: 'file',
				path,
				name: basename(path),
				depth,
				size: files.get(path) ?? 0,
			});
	}
	walk('', 0);
	return rows;
}

/**
 * Why `name` cannot name a file or folder inside `directory`, or undefined.
 * A name is one path segment; the folder's own path rules apply to the result.
 */
export function nameProblem(
	directory: string,
	name: string,
): string | undefined {
	if (name.trim() === '') return 'Enter a name.';
	if (name.includes('/')) return 'A name cannot contain "/".';
	if (name !== name.trim()) return 'A name cannot start or end with a space.';
	const problem = pathProblem(joinPath(directory, name));
	return problem === undefined
		? undefined
		: `This name is not usable: ${problem}.`;
}

/** Text larger than this opens as file details instead of in the editor. */
export const EDITABLE_TEXT_LIMIT = 1024 * 1024;

export type OpenedFile =
	| {
			readonly kind: 'text';
			readonly file: {
				readonly path: string;
				readonly source: string;
				readonly version: FileVersion;
			};
	  }
	/** Not UTF-8 text, or text with NUL bytes: shown as details, never saved as text. */
	| { readonly kind: 'binary'; readonly size: number }
	| { readonly kind: 'tooLarge'; readonly size: number };

const utf8 = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true });

/**
 * Read a file for the editor. Only valid UTF-8 without NUL bytes opens as
 * text, and the decoded text keeps a byte order mark so a save writes the
 * same bytes back.
 */
export async function readTextFile(
	files: FolderFiles,
	path: string,
): Promise<Result<OpenedFile, FileError>> {
	const read = await files.read(path);
	if (read.error) return read;
	const { bytes, version } = read.data;
	if (bytes.byteLength > EDITABLE_TEXT_LIMIT)
		return Ok({ kind: 'tooLarge', size: bytes.byteLength });
	if (bytes.includes(0)) return Ok({ kind: 'binary', size: bytes.byteLength });
	try {
		return Ok({
			kind: 'text',
			file: { path, source: utf8.decode(bytes), version },
		});
	} catch {
		return Ok({ kind: 'binary', size: bytes.byteLength });
	}
}

/** Textareas report LF; keep the file's CRLF line endings when it uses them. */
export function withFileNewlines(text: string, reference: string): string {
	return reference.includes('\r\n') ? text.replace(/\r?\n/g, '\r\n') : text;
}

const KINDS: Record<string, string> = {
	md: 'Markdown',
	txt: 'Plain text',
	json: 'JSON',
	yaml: 'YAML',
	yml: 'YAML',
	csv: 'CSV',
	png: 'PNG image',
	jpg: 'JPEG image',
	jpeg: 'JPEG image',
	gif: 'GIF image',
	webp: 'WebP image',
	svg: 'SVG image',
	pdf: 'PDF document',
	zip: 'ZIP archive',
};

/** A short, human file type from the name alone. */
export function fileKind(path: string): string {
	const name = basename(path);
	const dot = name.lastIndexOf('.');
	if (dot <= 0) return name.startsWith('.') ? 'Settings file' : 'File';
	const extension = name.slice(dot + 1).toLowerCase();
	return KINDS[extension] ?? `${extension.toUpperCase()} file`;
}

export function formatSize(bytes: number): string {
	if (bytes < 1024) return `${bytes} ${bytes === 1 ? 'byte' : 'bytes'}`;
	if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
	return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}
