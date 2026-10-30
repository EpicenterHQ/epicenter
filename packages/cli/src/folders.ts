/**
 * Epicenter's records folder.
 *
 * Records are the fixed `<folderDir>/so.epicenter`, the directory the desktop
 * binds for Settings (`library::RECORDS` in `epicenter-folder-core`). Nothing
 * selects, saves, or locks the location, and no configuration is read.
 */
import { lstat, mkdir, realpath, stat } from 'node:fs/promises';
import {
	basename,
	dirname,
	isAbsolute,
	join,
	parse,
	relative,
	sep,
} from 'node:path';
import type { AppPaths } from './app-paths.js';

/** The records default's permanent name under the folder root. */
const RECORDS = 'so.epicenter';

/**
 * The records folder's canonical path, or `undefined` when it is not there
 * and `create` is not set. A noncreating read makes nothing; a creating one
 * makes the root and the folder when missing and reuses one that is there.
 * Either way the location is admitted first, and a file or a link there is
 * refused.
 */
export async function epicenterDirectory(
	paths: AppPaths,
	create: boolean,
): Promise<string | undefined> {
	const path = join(paths.folderDir, RECORDS);
	await checkRecordsDirectory(paths.dataDir, path);
	let kind = await lstat(path).catch((cause: NodeJS.ErrnoException) => {
		if (cause.code === 'ENOENT') return undefined;
		throw cause;
	});
	if (kind === undefined && create) {
		await mkdir(dirname(path), { recursive: true });
		await mkdir(path).catch((cause: NodeJS.ErrnoException) => {
			if (cause.code !== 'EEXIST') throw cause;
		});
		kind = await lstat(path);
	}
	if (kind !== undefined && !kind.isDirectory())
		throw new Error(`${path} is a link or not a directory.`);
	return kind === undefined ? undefined : realpath(path);
}

/**
 * The same admission as native `library::check_editable_directory` for the
 * records default. The shared `records-default.json` cases exercise both
 * implementations before anything is created.
 */
async function checkRecordsDirectory(dataDir: string, path: string) {
	const candidate = await directoryPaths(path);
	if (
		candidate[0]
			.split(sep)
			.some(
				(name) =>
					name.startsWith('.') &&
					name.toLowerCase().endsWith('.epicenter-scratch'),
			)
	)
		throw new Error(
			'Save staging directories cannot be opened as authored folders.',
		);
	const data = await resolvedPath(dataDir);
	for (const path of candidate) {
		if (await overlaps(path, data))
			throw new Error(
				"This folder holds Epicenter's machine-local application data, so it cannot be opened.",
			);
	}
}

/** Saving also writes to a sibling staging directory. Admit both locations. */
async function directoryPaths(path: string) {
	const root = await resolvedPath(path);
	return [
		root,
		await resolvedPath(
			join(dirname(root), `.${basename(root)}.epicenter-scratch`),
		),
	] as const;
}

/** Resolve existing ancestors, retaining missing components and their parent steps. */
async function resolvedPath(path: string) {
	let resolved = parse(path).root;
	for (const component of path.slice(resolved.length).split(sep)) {
		if (component === '' || component === '.') continue;
		if (component === '..') resolved = dirname(resolved);
		else {
			resolved = join(resolved, component);
			resolved = await realpath(resolved).catch(() => resolved);
		}
	}
	return resolved;
}

function contains(parent: string, child: string) {
	const path = relative(parent, child);
	return (
		path === '' ||
		(!isAbsolute(path) && path !== '..' && !path.startsWith(`..${sep}`))
	);
}

/** Include OS aliases that realpath does not merge, such as macOS firmlinks. */
async function overlaps(left: string, right: string) {
	if (contains(left, right) || contains(right, left)) return true;
	const [leftIdentity, rightIdentity] = await Promise.all([
		stat(left, { bigint: true }).catch(() => undefined),
		stat(right, { bigint: true }).catch(() => undefined),
	]);
	for (const [path, identity] of [
		[left, rightIdentity],
		[right, leftIdentity],
	] as const) {
		if (identity === undefined) continue;
		for (let ancestor = path; ; ancestor = dirname(ancestor)) {
			const current = await stat(ancestor, { bigint: true }).catch(
				() => undefined,
			);
			if (current?.dev === identity.dev && current.ino === identity.ino)
				return true;
			if (dirname(ancestor) === ancestor) break;
		}
	}
	return false;
}
