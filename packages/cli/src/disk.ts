/**
 * An action's folder on this computer's disk (ADR-0841, ADR-0850). It is a
 * convenience, not a sandbox: paths are normalized and `.git` is refused, and
 * otherwise a write is a write. Writes replace a whole file at once, keeping
 * the mode of the file they replace; a new `.local` file is `0600`, readable
 * by its owner alone (ADR-0870). `update` replaces it only when it is
 * still what its change read, so concurrent updates of one file, from any
 * process, each land. Listing avoids Git, dependencies, and directory links
 * so those trees never become app data.
 */

import { createHash, randomUUID } from 'node:crypto';
import { type Dirent, readFileSync, renameSync, unlinkSync } from 'node:fs';
import {
	chmod,
	lstat,
	mkdir,
	open,
	readdir,
	readFile,
	rename,
	rm,
	stat,
	unlink,
	writeFile,
} from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { type Folder, isLocalPath, normalizePath } from '@epicenter/app';

/** How many times `update` reads and changes a file that keeps changing before it gives up. */
const UPDATE_TRIES = 10;

/** How old another update's claim is before it is taken for one a crash left. */
const ABANDONED_MS = 30_000;

function missing(error: unknown) {
	return (error as NodeJS.ErrnoException).code === 'ENOENT';
}

/** A short name for `bytes`, or for no file, that two updates of the same file share. */
function bytesTag(bytes: Uint8Array | undefined) {
	return bytes === undefined
		? 'none'
		: createHash('sha256').update(bytes).digest('hex').slice(0, 16);
}

/** The bytes at `target` now, read without yielding. */
function readNow(target: string) {
	try {
		return readFileSync(target);
	} catch (error) {
		if (missing(error)) return undefined;
		throw error;
	}
}

/** Whether two reads found the same file: the same bytes, or no file both times. */
function sameBytes(a: Buffer | undefined, b: Uint8Array | undefined) {
	return a === undefined || b === undefined ? a === b : a.equals(b);
}

/** An update's claim on replacing one file's bytes: the file it made, and the token it wrote there. */
type Claim = { path: string; token: string };

/** Whether `claim`'s file still holds its token, read without yielding. */
function holds(claim: Claim) {
	try {
		return readFileSync(claim.path, 'utf8') === claim.token;
	} catch (error) {
		if (missing(error)) return false;
		throw error;
	}
}

/**
 * Remove `claim`'s file if it is still this update's. A failure leaves it to
 * be taken as abandoned once it is old, and never fails a write that landed.
 */
function release(claim: Claim) {
	try {
		if (holds(claim)) unlinkSync(claim.path);
	} catch {}
}

/**
 * Make the claim file at `path`, holding a token no other update has, or
 * answer `undefined` when another update holds it. A claim older than
 * `ABANDONED_MS` is one a crash left, and is cleared before trying once more.
 */
async function claim(path: string): Promise<Claim | undefined> {
	for (let cleared = false; ; cleared = true) {
		let handle: Awaited<ReturnType<typeof open>>;
		try {
			handle = await open(path, 'wx');
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
			if (cleared || !(await clearAbandoned(path))) return undefined;
			continue;
		}
		const token = randomUUID();
		try {
			await handle.writeFile(token);
			await handle.close();
		} catch (error) {
			// This update made the file, so it removes it rather than leave it to block others.
			await handle.close().catch(() => {});
			await rm(path, { force: true });
			throw error;
		}
		return { path, token };
	}
}

/**
 * Clear the claim at `path` when a crash left it, answering whether it did.
 * It renames the claim to a name of its own rather than removing it by name,
 * so two updates that found it never remove each other's fresh claim, and
 * takes it for abandoned only when the file it renamed is still that old.
 */
async function clearAbandoned(path: string) {
	const left = await stat(path).catch(() => undefined);
	if (!left || Date.now() - left.mtimeMs <= ABANDONED_MS) return false;
	const taken = `${path}.${randomUUID()}.stale.local`;
	try {
		await rename(path, taken);
	} catch (error) {
		if (missing(error)) return false;
		throw error;
	}
	// Another update may have cleared the old claim and made its own since the
	// stat. Its maker finds its token gone and tries again, so removing it is safe.
	const renamed = await stat(taken).catch(() => undefined);
	await rm(taken, { force: true });
	return renamed !== undefined && Date.now() - renamed.mtimeMs > ABANDONED_MS;
}

/** The app's folder at `dir`, its methods reading and writing the disk. */
export function folderOnDisk(dir: string): Folder {
	const pathOf = (path: string) => join(dir, normalizePath(path));
	async function readBytes(path: string) {
		try {
			return await readFile(pathOf(path));
		} catch (error) {
			if (missing(error)) return undefined;
			throw error;
		}
	}
	/**
	 * Write `bytes` beside the file at `path` and rename it over, so a reader
	 * never sees half a file; a file it replaces keeps its mode, and a new
	 * `.local` file is `0600` from before it has a name there. The files
	 * beside it are named `*.local`, so a snapshot taken meanwhile never
	 * commits them.
	 *
	 * Given `replacing`, the bytes the new ones were made from (`undefined`
	 * for no file), it writes only over those bytes, and answers whether it
	 * did. It first claims them with a file named for them that only one
	 * update can make, so two updates of the same bytes never both write; and
	 * just before the rename it checks that the claim is still its own and the
	 * file still those bytes, leaving the file as it is otherwise.
	 */
	async function replace(
		path: string,
		bytes: Uint8Array,
		replacing?: { bytes: Uint8Array | undefined },
	) {
		const target = pathOf(path);
		await mkdir(dirname(target), { recursive: true });
		const claimed = replacing
			? await claim(`${target}.${bytesTag(replacing.bytes)}.claim.local`)
			: undefined;
		if (replacing && !claimed) return false;
		const temp = `${target}.${randomUUID()}.tmp.local`;
		let renamed = false;
		try {
			let mode = isLocalPath(normalizePath(path)) ? 0o600 : undefined;
			try {
				mode = (await stat(target)).mode & 0o7777;
			} catch (error) {
				if (!missing(error)) throw error;
			}
			await writeFile(temp, bytes, mode === undefined ? {} : { mode });
			if (mode !== undefined) await chmod(temp, mode);
			if (!replacing) await rename(temp, target);
			// Check and rename without yielding, so nothing in this process runs between them.
			else if (
				claimed &&
				holds(claimed) &&
				sameBytes(readNow(target), replacing.bytes)
			)
				renameSync(temp, target);
			else return false;
			renamed = true;
			return true;
		} finally {
			if (!renamed) await rm(temp, { force: true });
			if (claimed) release(claimed);
		}
	}
	const decode = (bytes: Uint8Array | undefined) =>
		bytes === undefined ? undefined : new TextDecoder().decode(bytes);
	return {
		path: dir,
		readBytes,
		read: async (path) => decode(await readBytes(path)),
		async writeBytes(path, bytes) {
			await replace(path, bytes);
		},
		async write(path, text) {
			await replace(path, new TextEncoder().encode(text));
		},
		async update(path, change) {
			for (let tries = 1; ; tries++) {
				// Compared as bytes: decoding drops a byte order mark the file still has.
				const before = await readBytes(path);
				const changed = change(decode(before));
				const bytes = new TextEncoder().encode(changed);
				if (await replace(path, bytes, { bytes: before })) return changed;
				if (tries === UPDATE_TRIES)
					throw Object.freeze({
						name: 'Changed',
						message: `${normalizePath(path)} kept changing while it was updated`,
					});
				// A random wait, doubling with each try, so updates that met spread apart.
				await Bun.sleep(Math.random() * 2 ** tries);
			}
		},
		async delete(path) {
			try {
				await unlink(pathOf(path));
			} catch (error) {
				if (missing(error)) return;
				throw error;
			}
		},
		async list(subdir) {
			const found: string[] = [];
			async function walk(relative: string) {
				let entries: Dirent[];
				try {
					entries = await readdir(join(dir, relative), { withFileTypes: true });
				} catch (error) {
					if (missing(error)) return;
					throw error;
				}
				for (const entry of entries) {
					const path = relative ? `${relative}/${entry.name}` : entry.name;
					if (entry.name === '.git' || entry.name === 'node_modules') continue;
					if (entry.isDirectory()) await walk(path);
					else if (entry.isFile()) found.push(path);
					else if (entry.isSymbolicLink()) {
						try {
							if ((await stat(join(dir, path))).isFile()) found.push(path);
						} catch (error) {
							if (!missing(error)) throw error;
						}
					}
				}
			}
			const relative = subdir === undefined ? '' : normalizePath(subdir);
			if (
				relative
					.split('/')
					.some((part) => part === '.git' || part === 'node_modules')
			)
				return [];
			if (relative) {
				let current = dir;
				for (const part of relative.split('/')) {
					current = join(current, part);
					try {
						if ((await lstat(current)).isSymbolicLink()) return [];
					} catch (error) {
						if (missing(error)) return [];
						throw error;
					}
				}
			}
			await walk(relative);
			return found.sort();
		},
	};
}
