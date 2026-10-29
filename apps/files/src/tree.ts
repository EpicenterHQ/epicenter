/**
 * A repository's files as folders. Git keeps no folders, so a folder is the
 * shared prefix of the files under it, and one with no file under it does
 * not exist. Files' path names what it shows: `/` the root, `/<folder>/` a
 * folder (the trailing `/`), `/<file>` a file, each segment encoded.
 */
import { fileOfPath, pathOfFile } from '@epicenter/app';
import type { FileEntry } from '@epicenter/repository';

/** What a folder holds directly: its folders, by name, and its files, ordered by name. */
export type Listing = { folders: string[]; files: FileEntry[] };

/** The folder of a path: `''` for the root. */
export const parentOf = (file: string) => file.slice(0, Math.max(0, file.lastIndexOf('/')));

/** The last segment of a path. */
export const nameOf = (path: string) => path.slice(path.lastIndexOf('/') + 1);

/** `name` inside `folder`. */
export const inFolder = (folder: string, name: string) => (folder === '' ? name : `${folder}/${name}`);

/** The folder an app path names (`/` or `/<folder>/`), or undefined when it names a file. */
export function folderOfPath(path: string): string | undefined {
	const [pathname = ''] = path.split(/[?#]/, 1);
	if (pathname === '' || pathname === '/') return '';
	if (!pathname.endsWith('/')) return undefined;
	const file = fileOfPath(pathname.slice(0, -1));
	return file;
}

/** The app path that names `folder`. */
export const pathOfFolder = (folder: string) => (folder === '' ? '/' : `${pathOfFile(folder)}/`);

/** What `folder` holds directly, among `files`. */
export function listingOf(files: readonly FileEntry[], folder: string): Listing {
	const prefix = folder === '' ? '' : `${folder}/`;
	const folders = new Set<string>();
	const direct: FileEntry[] = [];
	for (const entry of files) {
		if (!entry.path.startsWith(prefix)) continue;
		const rest = entry.path.slice(prefix.length);
		const slash = rest.indexOf('/');
		if (slash === -1) direct.push(entry);
		else folders.add(rest.slice(0, slash));
	}
	return { folders: [...folders].sort(), files: direct.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0)) };
}

/** Why `path` cannot be a new file's path among `files`, or undefined when it can. */
export function newPathProblem(files: readonly FileEntry[], path: string): string | undefined {
	if (path === '' || nameOf(path) === '') return 'Enter a name.';
	if (path.startsWith('/') || path.includes('//')) return 'A path cannot start with / or hold an empty folder.';
	const folded = path.normalize('NFC').toLowerCase();
	if (files.some((entry) => entry.path.normalize('NFC').toLowerCase() === folded)) return `A file is already at ${path}.`;
	if (files.some((entry) => entry.path.normalize('NFC').toLowerCase().startsWith(`${folded}/`))) return `A folder is already at ${path}.`;
	return undefined;
}
