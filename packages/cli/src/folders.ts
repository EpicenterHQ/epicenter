/**
 * This machine's folder choices. The desktop reads the same folders.json
 * object and uses the same SQLite save lock before replacing it.
 */
import {
	lstat,
	mkdir,
	mkdtemp,
	open,
	readFile,
	realpath,
	rename,
	rm,
	stat,
} from 'node:fs/promises';
import {
	basename,
	dirname,
	isAbsolute,
	join,
	parse,
	relative,
	resolve,
	sep,
} from 'node:path';
import { holdingFileLock } from '@epicenter/folder/bun';
import type { AppPaths } from './app-paths.js';
import { resolveAppPaths } from './app-paths.js';
import { EXIT, writeJson, writeOut } from './output.js';

type FoldersConfig = {
	homes: Record<string, string>;
	folders: string[];
};

/** Read without creating a file or selecting a records folder. */
async function readFoldersConfig(dataDir: string): Promise<FoldersConfig> {
	const path = join(dataDir, 'folders.json');
	try {
		const kind = await lstat(path).catch((cause: NodeJS.ErrnoException) => {
			if (cause.code === 'ENOENT') return undefined;
			throw cause;
		});
		if (kind === undefined) return { homes: {}, folders: [] };
		if (!kind.isFile()) throw new Error('it is not a regular file');
		const value: unknown = JSON.parse(
			new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(
				await readFile(path),
			),
		);
		// Existing desktop installations stored only the shortcuts. Convert
		// those arrays on a real change, preserving every original spelling.
		if (
			Array.isArray(value) &&
			value.every((entry) => typeof entry === 'string')
		)
			return { homes: {}, folders: value };
		// Preserve an existing records selection when reading the previous format.
		if (
			typeof value === 'object' &&
			value !== null &&
			!Array.isArray(value) &&
			'epicenter' in value &&
			'folders' in value &&
			Object.keys(value).every(
				(key) => key === 'epicenter' || key === 'folders',
			) &&
			(value.epicenter === null ||
				(typeof value.epicenter === 'string' && isAbsolute(value.epicenter))) &&
			Array.isArray(value.folders) &&
			value.folders.every((entry) => typeof entry === 'string')
		)
			return {
				homes: value.epicenter === null ? {} : { epicenter: value.epicenter },
				folders: value.folders,
			};
		if (
			typeof value !== 'object' ||
			value === null ||
			Array.isArray(value) ||
			Object.keys(value).some((key) => key !== 'homes' && key !== 'folders') ||
			!('homes' in value) ||
			typeof value.homes !== 'object' ||
			value.homes === null ||
			Array.isArray(value.homes) ||
			!Object.values(value.homes).every(
				(path) => typeof path === 'string' && isAbsolute(path),
			) ||
			!('folders' in value) ||
			!Array.isArray(value.folders) ||
			!value.folders.every((entry) => typeof entry === 'string')
		)
			throw new Error(
				'expected {"homes": {<app>: <absolute path>}, "folders": [<paths>]}',
			);
		return {
			homes: value.homes as Record<string, string>,
			folders: value.folders,
		};
	} catch (cause) {
		throw new Error(
			`${path} was left unchanged: ${cause instanceof Error ? cause.message : String(cause)}. Repair folders.json to use folder configuration again.`,
		);
	}
}

/** Read/change/replace under the desktop's lock, so another writer's fields survive. */
async function updateFolders<T>(
	dataDir: string,
	change: (config: FoldersConfig) => Promise<T>,
) {
	const path = join(dataDir, 'folders.json');
	return holdingFileLock(
		join(dataDir, '.folders.json.epicenter-save-lock'),
		{
			waitMs: 10_000,
			held: `${path} was not updated: another writer held its save lock. Try again.`,
		},
		async () => {
			const config = await readFoldersConfig(dataDir);
			const before = JSON.stringify(config);
			const answer = await change(config);
			if (JSON.stringify(config) === before) return answer;
			const staged = await mkdtemp(join(dataDir, '.folders.json.'));
			try {
				const file = join(staged, 'staged');
				const output = await open(file, 'wx');
				try {
					await output.writeFile(`${JSON.stringify(config, null, 2)}\n`);
					await output.sync();
				} finally {
					await output.close();
				}
				await rename(file, path);
			} finally {
				await rm(staged, { recursive: true, force: true });
			}
			return answer;
		},
	);
}

/** Select the initial default only on first use. A selected missing path is an error. */
export async function epicenterDirectory(
	paths: AppPaths,
	create: boolean,
): Promise<string | undefined> {
	async function directory(config: FoldersConfig) {
		const path =
			config.homes.epicenter ?? join(paths.folderDir, 'so.epicenter');
		await checkRecordsDirectory(config, paths.dataDir, path);
		let kind = await lstat(path).catch((cause: NodeJS.ErrnoException) => {
			if (cause.code === 'ENOENT') return undefined;
			throw cause;
		});
		if (kind === undefined && config.homes.epicenter !== undefined)
			throw new Error(
				`The Epicenter data folder ${path} is not there. Repair its path in folders.json.`,
			);
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
	if (!create) return directory(await readFoldersConfig(paths.dataDir));
	return updateFolders(paths.dataDir, async (config) => {
		const path = await directory(config);
		if (path !== undefined) config.homes.epicenter = path;
		return path;
	});
}

/** Same admission rules as native homes::validate_home for Epicenter records.
 * Shared home-allocation fixtures exercise both implementations before a
 * directory is created or a selection is persisted.
 */
async function checkRecordsDirectory(
	config: FoldersConfig,
	dataDir: string,
	path: string,
) {
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
				"A home folder cannot overlap Epicenter's machine-local application data.",
			);
	}
	for (const [key, path] of Object.entries(config.homes)) {
		if (key === 'epicenter') continue;
		const other = await directoryPaths(path);
		for (const own of candidate) {
			for (const location of other) {
				if (await overlaps(own, location))
					throw new Error(
						`Epicenter's records folder cannot overlap the ${key} home.`,
					);
			}
		}
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

/** CLI folder commands edit shortcuts only; none moves files or changes Git. */
export async function foldersCommand(
	action: 'add' | 'list' | 'forget',
	input: string | undefined,
	json: boolean,
) {
	const { dataDir } = resolveAppPaths();
	if (action === 'list') {
		const config = await readFoldersConfig(dataDir);
		const folders = await Promise.all(
			config.folders.map(async (path) => {
				let problem: string | null = null;
				try {
					if (!isAbsolute(path))
						throw new Error('This is not an absolute folder path.');
					if (!(await lstat(path)).isDirectory())
						throw new Error('This path is a link or not a folder.');
				} catch (cause) {
					problem = cause instanceof Error ? cause.message : String(cause);
				}
				return { path, problem };
			}),
		);
		if (json)
			writeJson({
				epicenter: config.homes.epicenter ?? null,
				homes: config.homes,
				folders,
			});
		else
			for (const { path, problem } of folders)
				writeOut(problem === null ? path : `${path}\t${problem}`);
		return EXIT.ok;
	}
	const supplied = input as string;
	// Forget can match a malformed or missing entry verbatim; add resolves a
	// relative argument once, without resolving symbolic links into another path.
	let path = resolve(supplied);
	if (action === 'add' && !(await lstat(path)).isDirectory())
		throw new Error(`${path} is a link or not a folder.`);
	const changed = await updateFolders(dataDir, async (config) => {
		const before = config.folders.length;
		if (action === 'forget' && config.folders.includes(supplied))
			path = supplied;
		if (action === 'add') {
			if (!config.folders.includes(path)) config.folders.push(path);
		} else {
			config.folders = config.folders.filter((entry) => entry !== path);
		}
		return config.folders.length !== before;
	});
	if (json) writeJson({ path, changed });
	else writeOut(`${action === 'add' ? 'Added' : 'Forgot'} ${path}`);
	return EXIT.ok;
}
