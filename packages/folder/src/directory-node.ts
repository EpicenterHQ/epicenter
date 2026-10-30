/**
 * Directory primitives over `node:fs`, for Bun and Node: tests, scripts, and
 * any host that can reach the disk itself.
 *
 * A rename or removal checks what it expects at its path and then changes
 * it: two steps, with nothing here holding the path between them. The caller
 * holds what keeps other saves out: `@epicenter/folder/bun` wraps each one in
 * the folder's save lock, the lock the desktop shell takes around its own
 * checked renames, so a Bun process's save and a window's never interleave.
 * A program that takes no save lock can still change the path in between.
 *
 * On Unix a private directory is `0700` and a private file `0600`, so no
 * other account reads what is staged in one. On macOS each also has no
 * access control entry, which could let another account past those bits;
 * one that cannot be removed refuses the stage. Windows has no such bits: a
 * directory or file made there has the access its parent passes on.
 */
import { execFile } from 'node:child_process';
import { constants } from 'node:fs';
import {
	chmod,
	type FileHandle,
	lstat,
	mkdir,
	open,
	readdir,
	readFile,
	realpath,
	rename,
	rm,
	rmdir,
	writeFile,
} from 'node:fs/promises';
import { basename } from 'node:path';
import { promisify } from 'node:util';
import type { Expectation } from './boundary.js';
import type { DirectoryPrimitives, EntryKind } from './directory-primitives.js';
import { UnexpectedTarget } from './errors.js';
import { hashBytes } from './hash.js';

type StampStats = {
	readonly size: bigint;
	readonly mtimeNs: bigint;
	readonly dev: bigint;
	readonly ino: bigint;
};

/** An opaque native change detector. Decimal strings preserve bigint precision. */
function stampOf(stats: StampStats): string {
	const identity =
		process.platform === 'win32' || stats.ino === 0n
			? ''
			: `:${stats.dev}:${stats.ino}`;
	return `v1:${stats.size}:${stats.mtimeNs}${identity}`;
}

const kindOf = (entry: {
	isFile(): boolean;
	isDirectory(): boolean;
	isSymbolicLink(): boolean;
}): EntryKind =>
	entry.isFile()
		? 'file'
		: entry.isDirectory()
			? 'directory'
			: entry.isSymbolicLink()
				? 'link'
				: 'other';

/** Reject with `UnexpectedTarget` unless `path` holds what `expected` says. */
async function check(path: string, expected: Expectation): Promise<void> {
	if (expected === 'any') return;
	const found = await lstat(path).catch((cause: { code?: string }) => {
		if (cause.code === 'ENOENT') return undefined;
		throw cause;
	});
	if (expected === 'absent') {
		if (found !== undefined)
			throw new UnexpectedTarget(path, { name: 'Exists' });
		return;
	}
	if (expected === 'present') {
		if (found === undefined)
			throw new UnexpectedTarget(path, { name: 'NotFound' });
		if (!found.isFile()) throw new Error(`'${path}' is not a file`);
		return;
	}
	if (!found?.isFile())
		throw new UnexpectedTarget(path, {
			name: 'Conflict',
			actualSha256: undefined,
		});
	const actualSha256 = await hashBytes(new Uint8Array(await readFile(path)));
	if (actualSha256 !== expected.sha256)
		throw new UnexpectedTarget(path, { name: 'Conflict', actualSha256 });
}

/** Whether this platform has Unix permission bits. */
const unix = process.platform !== 'win32';

const run = promisify(execFile);

/**
 * The access control entries on the entry at `path`, read without following
 * a link: `ls -lde` prints one line for the entry (`-q` keeps its name on
 * that line) and one more per entry, such as
 * ` 0: group:everyone inherited allow read,execute`.
 */
async function aclEntries(path: string): Promise<string[]> {
	const { stdout } = await run('/bin/ls', ['-ldeq', path], {
		env: { LC_ALL: 'C' },
	});
	return stdout
		.split('\n')
		.slice(1)
		.filter((line) => /^\s*\d+: /.test(line));
}

/**
 * On macOS, remove every access control entry on `path`, the entry `opened`
 * is open on, or reject. Mode bits do not limit an entry: one a parent
 * passes on, such as `everyone allow read`, lets other accounts read a
 * `0600` file. `node:fs` has no access control calls, so `/bin/ls` reads
 * them and `/bin/chmod -h -N` removes them, by path; the path must still
 * name the opened entry afterward, so what they saw and changed is it.
 * Other systems need nothing here: a Linux default ACL is masked by the
 * group bits of a `0700` or `0600` mode.
 */
async function withoutAcl(path: string, opened: FileHandle): Promise<void> {
	if (process.platform !== 'darwin') return;
	if ((await aclEntries(path)).length > 0) {
		await run('/bin/chmod', ['-h', '-N', path]);
		const left = await aclEntries(path);
		if (left.length > 0)
			throw new Error(
				`an access control list still lets other accounts open it: ${left.join('; ').trim()}`,
			);
	}
	const [held, named] = await Promise.all([opened.stat(), lstat(path)]);
	if (held.dev !== named.dev || held.ino !== named.ino)
		throw new Error('it changed while it was checked');
}

/**
 * Give `staged` the permission bits of the regular file at `target`, when
 * one is there, as the desktop shell's `keep_mode` does: only the read,
 * write, and execute bits, never setuid, setgid, or sticky.
 */
async function keepMode(target: string, staged: string): Promise<void> {
	if (!unix) return;
	const existing = await lstat(target).catch((cause: { code?: string }) => {
		if (cause.code === 'ENOENT') return undefined;
		throw cause;
	});
	if (existing?.isFile()) await chmod(staged, existing.mode & 0o777);
}

/**
 * Make the directory at `path`, whose parent is there, readable only by
 * this account: made `0700`, or tightened to it when an older version left
 * it open (`0755`), with no access control entry, such as one its parent
 * passes on (`withoutAcl`). Its mode is read and changed through the
 * directory opened without following a link, so a link swapped in is
 * refused, never followed and never changed. One another account owns
 * cannot be changed, and is refused.
 */
async function privateDirectory(path: string): Promise<void> {
	await mkdir(path, { mode: 0o700 }).catch((cause: { code?: string }) => {
		if (cause.code !== 'EEXIST') throw cause;
	});
	const seen = await lstat(path);
	if (!seen.isDirectory())
		throw new Error(
			`'${path}' is ${seen.isSymbolicLink() ? 'a symbolic link' : 'not a directory'}, so nothing was staged there. Remove it, then save again.`,
		);
	if (!unix) return;
	const tightened = async () => {
		const directory = await open(
			path,
			constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW,
		);
		try {
			const opened = await directory.stat();
			if (
				!opened.isDirectory() ||
				opened.dev !== seen.dev ||
				opened.ino !== seen.ino
			)
				throw new Error('it changed while it was checked');
			if ((opened.mode & 0o077) !== 0) {
				await directory.chmod(0o700);
				if (((await directory.stat()).mode & 0o077) !== 0)
					throw new Error('other accounts can still open it');
			}
			await withoutAcl(path, directory);
		} finally {
			await directory.close();
		}
	};
	await tightened().catch((cause: unknown) => {
		throw new Error(
			`'${path}' could not be made private to this account, so nothing was staged there: ${cause instanceof Error ? cause.message : String(cause)}`,
			{ cause },
		);
	});
}

export const nodeDirectoryPrimitives: DirectoryPrimitives = {
	async readDir(path) {
		const entries = await readdir(path, { withFileTypes: true });
		return entries.map((entry) => ({ name: entry.name, kind: kindOf(entry) }));
	},
	async lstat(path) {
		try {
			const stats = await lstat(path, { bigint: true });
			const kind = kindOf(stats);
			// `realpath` answers with the stored spelling; a link is not followed.
			// Racing a rename over the path, Bun's on Linux can answer with
			// `<name> (deleted)`, so a name it does not confirm is left out and
			// the directory store lists the parent instead.
			const asked = basename(path);
			const stored =
				kind === 'file' || kind === 'directory'
					? basename(await realpath(path))
					: undefined;
			const name = stored === asked ? stored : undefined;
			return {
				kind,
				size: Number(stats.size),
				stamp: stampOf(stats),
				mode: Number(stats.mode),
				name,
			};
		} catch (cause) {
			if ((cause as { code?: string }).code === 'ENOENT') return undefined;
			throw cause;
		}
	},
	async readFile(path) {
		return new Uint8Array(await readFile(path));
	},
	async readStamped(path) {
		const file = await open(
			path,
			constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0),
		);
		try {
			const stats = await file.stat({ bigint: true });
			if (!stats.isFile()) throw new Error(`'${path}' is not a regular file`);
			const bytes = new Uint8Array(await file.readFile());
			return { bytes, stamp: stampOf(stats) };
		} finally {
			await file.close();
		}
	},
	async writeFile(path, bytes, options) {
		const flag = options?.createNew ? 'wx' : 'w';
		if (!options?.private) return writeFile(path, bytes, { flag });
		if (!options.createNew)
			throw new Error('A private staged write must create a new file.');
		// `0600` from the start, and no access control entry the scratch
		// directory passed on, before the first byte.
		const file = await open(path, flag, 0o600);
		try {
			await withoutAcl(path, file).catch((cause: unknown) => {
				throw new Error(
					`'${path}' could not be made private to this account, so nothing was written to it: ${cause instanceof Error ? cause.message : String(cause)}`,
					{ cause },
				);
			});
			await file.writeFile(bytes);
		} finally {
			await file.close();
		}
	},
	async rename(from, to, expected) {
		await check(to, expected);
		const staged = await open(from, constants.O_RDONLY);
		try {
			await keepMode(to, from);
			const published = stampOf(await staged.stat({ bigint: true }));
			await rename(from, to);
			const afterRename = await staged
				.stat({ bigint: true })
				.then(stampOf, () => undefined);
			return published === afterRename ? afterRename : published;
		} finally {
			await staged.close();
		}
	},
	async remove(path, options) {
		if (options?.expected !== undefined) await check(path, options.expected);
		if (options?.recursive) await rm(path, { recursive: true });
		else if ((await lstat(path)).isDirectory()) await rmdir(path);
		else await rm(path);
	},
	async mkdir(path, options) {
		if (options?.private) await privateDirectory(path);
		else await mkdir(path, { recursive: true });
	},
};
