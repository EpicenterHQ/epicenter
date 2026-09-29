import { createHash, randomUUID } from 'node:crypto';
import {
	link,
	lstat,
	mkdir,
	readdir,
	readFile,
	realpath,
	rename,
	unlink,
	writeFile,
} from 'node:fs/promises';
import { basename, dirname, join, relative, resolve, sep } from 'node:path';
import {
	type AccountFiles,
	attachmentFor,
	checkedPath,
	type FileSnapshot,
	publicationConflict,
} from './files.js';

const writers = new Map<string, Promise<void>>();

async function exclusive<T>(
	root: string,
	operation: () => Promise<T>,
): Promise<T> {
	const previous = writers.get(root) ?? Promise.resolve();
	let release = () => {};
	const turn = new Promise<void>((resolve) => {
		release = resolve;
	});
	const queued = previous.then(() => turn);
	writers.set(root, queued);
	await previous;
	try {
		return await operation();
	} finally {
		release();
		if (writers.get(root) === queued) writers.delete(root);
	}
}

function revision(bytes: Uint8Array): string {
	return createHash('sha256').update(bytes).digest('hex');
}

export async function openNativeFiles(root: string): Promise<AccountFiles> {
	await mkdir(root, { recursive: true });
	const home = await realpath(root);
	const listeners = new Set<() => void>();
	const changed = () => {
		for (const listener of listeners) listener();
	};

	async function target(
		path: string,
		createParents: boolean,
	): Promise<string | undefined> {
		checkedPath(path);
		const full = resolve(home, path);
		if (!full.startsWith(`${home}${sep}`))
			throw new Error('Path escapes selected account folder');
		let parent = home;
		for (const part of path.split('/').slice(0, -1)) {
			parent = join(parent, part);
			let entry = await lstat(parent).catch((error: NodeJS.ErrnoException) => {
				if (error.code === 'ENOENT') return undefined;
				throw error;
			});
			if (!entry && createParents) {
				await mkdir(parent).catch((error: NodeJS.ErrnoException) => {
					if (error.code !== 'EEXIST') throw error;
				});
				entry = await lstat(parent);
			}
			if (!entry) return undefined;
			if (!entry.isDirectory() || entry.isSymbolicLink())
				throw new Error('Path crosses a non-directory or symlink');
			const physical = await realpath(parent);
			if (physical !== home && !physical.startsWith(`${home}${sep}`))
				throw new Error('Path escapes selected account folder');
		}
		const entry = await lstat(full).catch((error: NodeJS.ErrnoException) => {
			if (error.code === 'ENOENT') return undefined;
			throw error;
		});
		if (entry?.isSymbolicLink())
			throw new Error('Symlink is not a file in the selected account folder');
		return full;
	}

	const read = async (path: string): Promise<FileSnapshot | undefined> => {
		const full = await target(path, false);
		if (!full) return undefined;
		const bytes = await readFile(full).catch((error: NodeJS.ErrnoException) => {
			if (error.code === 'ENOENT') return undefined;
			throw error;
		});
		return bytes && { path, bytes, revision: revision(bytes) };
	};

	const list = async () => {
		const paths: string[] = [];
		async function visit(directory: string) {
			for (const entry of await readdir(directory, { withFileTypes: true })) {
				const full = join(directory, entry.name);
				if (entry.isSymbolicLink())
					throw new Error(
						`Account folder contains a symlink: ${relative(home, full)}`,
					);
				if (entry.isDirectory()) await visit(full);
				else if (entry.isFile())
					paths.push(relative(home, full).split(sep).join('/'));
				else
					throw new Error(
						`Account folder contains an unsupported file: ${relative(home, full)}`,
					);
			}
		}
		await visit(home);
		return paths.sort();
	};

	const createUnlocked = async (
		path: string,
		bytes: Uint8Array,
	): Promise<FileSnapshot> => {
		const full = await target(path, true);
		if (!full) throw new Error('Cannot create file without a parent');
		const temporary = join(
			dirname(full),
			`.file-notebook-${basename(full)}-${randomUUID()}.tmp`,
		);
		await writeFile(temporary, bytes, { flag: 'wx' });
		try {
			await link(temporary, full);
		} finally {
			await unlink(temporary);
		}
		changed();
		return { path, bytes: new Uint8Array(bytes), revision: revision(bytes) };
	};

	return {
		list,
		read,
		async snapshot() {
			return exclusive(home, async () => {
				const before = await list();
				const files = await Promise.all(before.map(read));
				const after = await list();
				if (
					before.join('\0') !== after.join('\0') ||
					files.some((file) => !file)
				) {
					throw new Error('Selected account folder changed during snapshot');
				}
				for (const file of files) {
					if (!file || (await read(file.path))?.revision !== file.revision) {
						throw new Error('Selected account folder changed during snapshot');
					}
				}
				return files as FileSnapshot[];
			});
		},
		async create(path, bytes) {
			return exclusive(home, async () => {
				const conflict = publicationConflict(await list(), [path]);
				if (conflict) throw new Error(conflict);
				return createUnlocked(path, bytes);
			});
		},
		async replace(source, bytes) {
			return exclusive(home, async () => {
				const full = await target(source.path, false);
				if (!full || (await read(source.path))?.revision !== source.revision)
					throw new Error(`Changed since read: ${source.path}`);
				const temporary = join(
					dirname(full),
					`.file-notebook-${basename(full)}-${randomUUID()}.tmp`,
				);
				await writeFile(temporary, bytes, { flag: 'wx' });
				try {
					if ((await read(source.path))?.revision !== source.revision)
						throw new Error(`Changed since read: ${source.path}`);
					await rename(temporary, full);
				} finally {
					await unlink(temporary).catch((error: NodeJS.ErrnoException) => {
						if (error.code !== 'ENOENT') throw error;
					});
				}
				changed();
				return {
					path: source.path,
					bytes: new Uint8Array(bytes),
					revision: revision(bytes),
				};
			});
		},
		async publishRow(rowPath, row, attachment) {
			if (
				attachment &&
				attachmentFor(rowPath, attachment.path.split('.').at(-1) ?? '') !==
					attachment.path
			) {
				throw new Error('Invalid attachment name');
			}
			await exclusive(home, async () => {
				const conflict = publicationConflict(
					await list(),
					attachment ? [attachment.path, rowPath] : [rowPath],
					rowPath,
				);
				if (conflict) throw new Error(conflict);
				if (attachment) await createUnlocked(attachment.path, attachment.bytes);
				try {
					await createUnlocked(rowPath, row);
				} catch (error) {
					if (attachment)
						throw new Error(
							`Row publication failed; attachment preserved at ${attachment.path}`,
							{ cause: error },
						);
					throw error;
				}
			});
		},
		subscribe(listener) {
			listeners.add(listener);
			return () => listeners.delete(listener);
		},
	};
}
