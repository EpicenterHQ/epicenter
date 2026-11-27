/**
 * `Files` on the desktop: the app's local data directory, which `main.rs`
 * allows in the file system scope and nothing outside it.
 *
 * Listing, writing and removing go through `tauri-plugin-fs`. Reading goes
 * through the app's own `files_read` command (`files.rs`), which reads every
 * path asked for in one call: a person can have 15,000 notes, and one call
 * each would be 15,000 round trips. A write goes to `<path>.tmp` beside the
 * file and is renamed over it, so a crash mid-write leaves the old file
 * whole; a listing never shows the `.tmp`, whose name has two extensions.
 */
import { convertFileSrc, invoke } from '@tauri-apps/api/core';
import { appLocalDataDir, join } from '@tauri-apps/api/path';
import {
	BaseDirectory,
	exists,
	mkdir,
	readDir,
	remove,
	rename,
	writeFile,
} from '@tauri-apps/plugin-fs';
import { extractErrorMessage } from 'wellcrafted/error';
import { Ok, type Result } from 'wellcrafted/result';
import {
	checkPath,
	type Files,
	type FilesError,
	failed,
	isPlainName,
	toBytes,
} from './files';

const baseDir = BaseDirectory.AppLocalData;

/** Run `work` on `path` once it is checked, answering what failed as `Io`. */
async function io<T>(
	what: string,
	path: string,
	work: (segments: string[]) => Promise<T>,
	{ directory = false } = {},
): Promise<Result<T, FilesError>> {
	const checked = checkPath(path, { directory });
	if (checked.error) return checked;
	try {
		return Ok(await work(checked.data));
	} catch (cause) {
		return failed(
			`Could not ${what} ${path || 'the folder'}: ${extractErrorMessage(cause)}`,
		);
	}
}

export function tauriFiles(): Files {
	return {
		keptIn: "this app's data folder",
		list: (dir) =>
			io(
				'list',
				dir,
				async () => {
					if (dir && !(await exists(dir, { baseDir }))) return [];
					const entries = await readDir(dir, { baseDir });
					return entries
						.filter((entry) => entry.isFile && isPlainName(entry.name))
						.map((entry) => entry.name)
						.sort();
				},
				{ directory: true },
			),

		async readMany(paths) {
			for (const path of paths) {
				const checked = checkPath(path);
				if (checked.error) return checked;
			}
			try {
				const read = await invoke<Record<string, string>>('files_read', {
					paths,
				});
				return Ok(new Map(Object.entries(read)));
			} catch (cause) {
				return failed(
					`Could not read the files: ${extractErrorMessage(cause)}`,
				);
			}
		},

		write: (path, contents) =>
			io('write', path, async (segments) => {
				const parent = segments.slice(0, -1).join('/');
				if (parent) await mkdir(parent, { baseDir, recursive: true });
				const temporary = `${path}.tmp`;
				await writeFile(temporary, toBytes(contents), { baseDir });
				await rename(temporary, path, {
					oldPathBaseDir: baseDir,
					newPathBaseDir: baseDir,
				});
				return undefined;
			}),

		remove: (path) =>
			io('remove', path, async () => {
				if (await exists(path, { baseDir })) await remove(path, { baseDir });
				return undefined;
			}),

		// Tauri's asset protocol streams the file and seeks without reading it
		// all; `main.rs` lets it read `recordings/` and nothing else.
		url: (path) =>
			io('find', path, async (segments) =>
				convertFileSrc(await join(await appLocalDataDir(), ...segments)),
			),
	};
}
