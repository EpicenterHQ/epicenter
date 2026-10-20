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
	rename,
	rm,
	stat,
} from 'node:fs/promises';
import { isAbsolute, join, resolve } from 'node:path';
import { holdingFileLock } from '@epicenter/folder/bun';
import type { AppPaths } from './app-paths.js';
import { resolveAppPaths } from './app-paths.js';
import { EXIT, writeJson, writeOut } from './output.js';

type FoldersConfig = {
	epicenter: string | null;
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
		if (kind === undefined) return { epicenter: null, folders: [] };
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
			return { epicenter: null, folders: value };
		if (
			typeof value !== 'object' ||
			value === null ||
			Array.isArray(value) ||
			Object.keys(value).some(
				(key) => key !== 'epicenter' && key !== 'folders',
			) ||
			!('epicenter' in value) ||
			(value.epicenter !== null &&
				(typeof value.epicenter !== 'string' ||
					!isAbsolute(value.epicenter))) ||
			!('folders' in value) ||
			!Array.isArray(value.folders) ||
			!value.folders.every((entry) => typeof entry === 'string')
		)
			throw new Error(
				'expected {"epicenter": <absolute path or null>, "folders": [<paths>]}',
			);
		return { epicenter: value.epicenter, folders: value.folders };
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
		const path = config.epicenter ?? join(paths.folderDir, 'so.epicenter');
		let kind = await lstat(path).catch((cause: NodeJS.ErrnoException) => {
			if (cause.code === 'ENOENT') return undefined;
			throw cause;
		});
		if (kind === undefined && config.epicenter !== null)
			throw new Error(
				`The Epicenter data folder ${path} is not there. Repair its path in folders.json.`,
			);
		if (kind === undefined && create) {
			const parent = await stat(paths.folderDir).catch(
				(cause: NodeJS.ErrnoException) => {
					if (cause.code === 'ENOENT')
						throw new Error(
							`The Epicenter folder ${paths.folderDir} is not there.`,
						);
					throw cause;
				},
			);
			if (!parent.isDirectory())
				throw new Error(
					`The Epicenter folder ${paths.folderDir} is not a directory.`,
				);
			await mkdir(path).catch((cause: NodeJS.ErrnoException) => {
				if (cause.code !== 'EEXIST') throw cause;
			});
			kind = await lstat(path);
		}
		if (kind !== undefined && !kind.isDirectory())
			throw new Error(`${path} is a link or not a directory.`);
		return kind === undefined ? undefined : path;
	}
	if (!create) return directory(await readFoldersConfig(paths.dataDir));
	return updateFolders(paths.dataDir, async (config) => {
		const path = await directory(config);
		if (path !== undefined) config.epicenter = path;
		return path;
	});
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
		if (json) writeJson({ epicenter: config.epicenter, folders });
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
