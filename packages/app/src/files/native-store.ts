/**
 * Ordinary files in a native folder.
 *
 * Current files are the source. A conditional write hashes the current bytes
 * and replaces them only when they match; this is a best-effort check, not an
 * operating-system-wide compare-and-swap against other programs. Exclusive
 * creation and moves use hard links, which fail rather than overwrite an
 * existing destination. Replacement writes a scratch file under
 * `.git/epicenter/scratch` and renames it into place.
 *
 * A multi-file batch applies ordered steps. When a step fails, the result
 * reports which steps reached the folder; nothing is rolled back.
 */
import {
	link,
	lstat,
	mkdir,
	readdir,
	readFile,
	realpath,
	rename,
	rmdir,
	unlink,
	writeFile,
} from 'node:fs/promises';
import { join } from 'node:path';
import { Err, Ok, type Result } from 'wellcrafted/result';
import type {
	CapturedFiles,
	FileBoundary,
	FileChange,
	FileListing,
	FileRead,
} from './boundary.js';
import { ApplyError, FileError, type FileStep } from './errors.js';
import { ancestors, isPortablePath, pathProblem } from './paths.js';
import { captureVersion, type FileVersion, satisfies } from './version.js';

type Code = { code?: string };
const codeOf = (cause: unknown) => (cause as Code | undefined)?.code;

export function createNativeFileBoundary(root: string): FileBoundary {
	const scratch = join(root, '.git', 'epicenter', 'scratch');
	const absolute = (path: string) => join(root, ...path.split('/'));

	function invalid(path: string): Result<never, FileError> | undefined {
		const problem = pathProblem(path);
		return problem === undefined
			? undefined
			: FileError.InvalidPath({ path, reason: problem });
	}

	/**
	 * Verify each component's literal spelling and that nothing on the way is
	 * a symbolic link, so a case-insensitive filesystem cannot alias another
	 * name and a link cannot escape the folder.
	 */
	async function verifyLiteral(
		path: string,
	): Promise<Result<'file' | 'directory' | 'absent', FileError>> {
		const parts = path.split('/');
		let directory = root;
		for (let index = 0; index < parts.length; index++) {
			const name = parts[index]!;
			let names: string[];
			try {
				names = await readdir(directory);
			} catch (cause) {
				if (codeOf(cause) === 'ENOENT') return Ok('absent');
				if (codeOf(cause) === 'ENOTDIR')
					return FileError.NotADirectory({
						path: parts.slice(0, index).join('/'),
					});
				return FileError.Io({
					path,
					operation: 'list the directory of',
					cause,
				});
			}
			if (!names.includes(name)) return Ok('absent');
			const next = join(directory, name);
			let stats: Awaited<ReturnType<typeof lstat>>;
			try {
				stats = await lstat(next);
			} catch (cause) {
				if (codeOf(cause) === 'ENOENT') return Ok('absent');
				return FileError.Io({ path, operation: 'inspect', cause });
			}
			if (stats.isSymbolicLink())
				return FileError.InvalidPath({
					path,
					reason: 'the path passes through a symbolic link',
				});
			const last = index === parts.length - 1;
			if (last) return Ok(stats.isDirectory() ? 'directory' : 'file');
			if (!stats.isDirectory())
				return FileError.NotADirectory({
					path: parts.slice(0, index + 1).join('/'),
				});
			directory = next;
		}
		return Ok('absent');
	}

	async function readCurrent(
		path: string,
	): Promise<Result<FileRead | undefined, FileError>> {
		const kind = await verifyLiteral(path);
		if (kind.error) return kind;
		if (kind.data === 'absent') return Ok(undefined);
		if (kind.data === 'directory') return FileError.NotAFile({ path });
		try {
			const bytes = new Uint8Array(await readFile(absolute(path)));
			return Ok({ bytes, version: await captureVersion(bytes) });
		} catch (cause) {
			if (codeOf(cause) === 'ENOENT') return Ok(undefined);
			return FileError.Io({ path, operation: 'read', cause });
		}
	}

	async function ensureParent(
		path: string,
	): Promise<Result<undefined, FileError>> {
		for (const parent of ancestors(path)) {
			const kind = await verifyLiteral(parent);
			if (kind.error) return kind;
			if (kind.data === 'file')
				return FileError.NotADirectory({ path: parent });
			if (kind.data === 'absent') {
				try {
					await mkdir(absolute(parent));
				} catch (cause) {
					if (codeOf(cause) !== 'EEXIST')
						return FileError.Io({ path: parent, operation: 'create', cause });
				}
			}
		}
		return Ok(undefined);
	}

	async function scratchFile(bytes: Uint8Array): Promise<string> {
		await mkdir(scratch, { recursive: true });
		const file = join(
			scratch,
			`${Date.now().toString(36)}-${crypto.randomUUID()}`,
		);
		await writeFile(file, bytes, { flag: 'wx' });
		return file;
	}

	function conflict(
		path: string,
		expected: FileChange['expected'],
		actual: FileVersion | undefined,
	) {
		return FileError.Conflict({ path, expected, actual });
	}

	/**
	 * Apply one change. A move is two filesystem steps; when its destination
	 * link lands but retiring the source fails, `landed` receives the
	 * destination write so the caller reports it instead of an ordinary error.
	 */
	async function step(
		change: FileChange,
		landed: FileStep[],
	): Promise<Result<undefined, FileError>> {
		if (change.kind === 'write') {
			const found = await readCurrent(change.path);
			if (found.error) return found;
			if (!satisfies(found.data?.version, change.expected))
				return conflict(change.path, change.expected, found.data?.version);
			const parent = await ensureParent(change.path);
			if (parent.error) return parent;
			let temporary: string;
			try {
				temporary = await scratchFile(change.bytes);
			} catch (cause) {
				return FileError.Io({
					path: change.path,
					operation: 'stage bytes for',
					cause,
				});
			}
			try {
				if (found.data === undefined && change.expected !== 'any') {
					// Exclusive creation: link fails instead of replacing a newcomer.
					try {
						await link(temporary, absolute(change.path));
					} catch (cause) {
						if (codeOf(cause) === 'EEXIST') {
							const now = await readCurrent(change.path);
							return conflict(change.path, change.expected, now.data?.version);
						}
						return FileError.Io({
							path: change.path,
							operation: 'create',
							cause,
						});
					}
				} else {
					try {
						await rename(temporary, absolute(change.path));
					} catch (cause) {
						return FileError.Io({
							path: change.path,
							operation: 'replace',
							cause,
						});
					}
				}
			} finally {
				await unlink(temporary).catch(() => {});
			}
			return Ok(undefined);
		}
		if (change.kind === 'remove') {
			const found = await readCurrent(change.path);
			if (found.error) return found;
			if (found.data === undefined)
				return FileError.NotFound({ path: change.path });
			if (!satisfies(found.data.version, change.expected))
				return conflict(change.path, change.expected, found.data.version);
			try {
				await unlink(absolute(change.path));
			} catch (cause) {
				if (codeOf(cause) === 'ENOENT')
					return FileError.NotFound({ path: change.path });
				return FileError.Io({ path: change.path, operation: 'remove', cause });
			}
			return Ok(undefined);
		}
		const found = await readCurrent(change.from);
		if (found.error) return found;
		if (found.data === undefined)
			return FileError.NotFound({ path: change.from });
		if (!satisfies(found.data.version, change.expected))
			return conflict(change.from, change.expected, found.data.version);
		const destination = await verifyLiteral(change.to);
		if (destination.error) return destination;
		if (destination.data === 'directory')
			return FileError.NotAFile({ path: change.to });
		if (destination.data === 'file') {
			const now = await readCurrent(change.to);
			return conflict(change.to, 'absent', now.data?.version);
		}
		const parent = await ensureParent(change.to);
		if (parent.error) return parent;
		try {
			await link(absolute(change.from), absolute(change.to));
		} catch (cause) {
			if (codeOf(cause) === 'EEXIST') {
				const now = await readCurrent(change.to);
				return conflict(change.to, 'absent', now.data?.version);
			}
			return FileError.Io({ path: change.to, operation: 'move to', cause });
		}
		landed.push({ kind: 'write', path: change.to });
		try {
			await unlink(absolute(change.from));
		} catch (cause) {
			// Both paths now hold the bytes; nothing is rolled back.
			return FileError.Io({ path: change.from, operation: 'retire', cause });
		}
		return Ok(undefined);
	}

	function toStep(change: FileChange): FileStep {
		return change.kind === 'move'
			? { kind: 'move', from: change.from, to: change.to }
			: { kind: change.kind, path: change.path };
	}

	async function walk(
		directory: string,
		prefix: string,
		files: { path: string; size: number }[],
		directories: string[],
	) {
		const entries = await readdir(directory, { withFileTypes: true });
		for (const entry of entries) {
			const path = prefix === '' ? entry.name : `${prefix}/${entry.name}`;
			if (prefix === '' && entry.name === '.git') continue;
			if (entry.isDirectory()) {
				directories.push(path);
				await walk(join(directory, entry.name), path, files, directories);
			} else if (entry.isFile()) {
				const stats = await lstat(join(directory, entry.name));
				files.push({ path, size: stats.size });
			}
		}
	}

	return {
		async list() {
			const files: { path: string; size: number }[] = [];
			const directories: string[] = [];
			try {
				await walk(root, '', files, directories);
			} catch (cause) {
				return FileError.Io({ path: '', operation: 'enumerate', cause });
			}
			files.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
			const listing: FileListing = { files, directories: directories.sort() };
			return Ok(listing);
		},
		async children(directory) {
			if (directory !== '') {
				const refused = invalid(directory);
				if (refused) return refused;
				const kind = await verifyLiteral(directory);
				if (kind.error) return kind;
				if (kind.data === 'absent')
					return FileError.NotFound({ path: directory });
				if (kind.data === 'file')
					return FileError.NotADirectory({ path: directory });
			}
			try {
				const entries = await readdir(
					directory === '' ? root : absolute(directory),
					{ withFileTypes: true },
				);
				const files: string[] = [];
				const directories: string[] = [];
				for (const entry of entries) {
					if (directory === '' && entry.name === '.git') continue;
					if (entry.isFile()) files.push(entry.name);
					else if (entry.isDirectory()) directories.push(entry.name);
				}
				return Ok({ files: files.sort(), directories: directories.sort() });
			} catch (cause) {
				return FileError.Io({ path: directory, operation: 'list', cause });
			}
		},
		async read(path) {
			const refused = invalid(path);
			if (refused) return refused;
			const found = await readCurrent(path);
			if (found.error) return found;
			if (found.data === undefined) return FileError.NotFound({ path });
			return Ok(found.data);
		},
		async readMany(paths) {
			const results = new Map<string, Result<FileRead, FileError>>();
			for (const path of paths) results.set(path, await this.read(path));
			return Ok(results);
		},
		async open(path) {
			// The bytes are copied into memory, so replacing the path later does not
			// change what the consumer receives (ADR-0466).
			const read = await this.read(path);
			if (read.error) return read;
			return Ok(new Blob([read.data.bytes as Uint8Array<ArrayBuffer>]));
		},
		async apply(changes) {
			for (const change of changes) {
				const paths =
					change.kind === 'move' ? [change.from, change.to] : [change.path];
				for (const path of paths) {
					const refused = invalid(path);
					if (refused) return refused;
				}
			}
			const applied: FileStep[] = [];
			for (let index = 0; index < changes.length; index++) {
				const change = changes[index]!;
				const landed: FileStep[] = [];
				const result = await step(change, landed);
				if (result.error) {
					const reached = [...applied, ...landed];
					// A refusal before anything landed wrote nothing; report it directly.
					if (reached.length === 0) return Err(result.error);
					return ApplyError.Partial({
						applied: reached,
						// A move whose destination landed failed at retiring its source.
						failed:
							landed.length > 0 && change.kind === 'move'
								? { kind: 'remove', path: change.from }
								: toStep(change),
						error: result.error,
						notAttempted: changes.slice(index + 1).map(toStep),
					});
				}
				applied.push(toStep(change));
			}
			return Ok(undefined);
		},
		async mkdir(path) {
			const refused = invalid(path);
			if (refused) return refused;
			const parent = await ensureParent(`${path}/x`);
			if (parent.error) return parent;
			return Ok(undefined);
		},
		async rmdir(path) {
			const refused = invalid(path);
			if (refused) return refused;
			const kind = await verifyLiteral(path);
			if (kind.error) return kind;
			if (kind.data === 'absent') return FileError.NotFound({ path });
			if (kind.data === 'file') return FileError.NotADirectory({ path });
			try {
				await rmdir(absolute(path));
				return Ok(undefined);
			} catch (cause) {
				if (codeOf(cause) === 'ENOTEMPTY' || codeOf(cause) === 'EEXIST')
					return FileError.DirectoryNotEmpty({ path });
				return FileError.Io({ path, operation: 'remove directory', cause });
			}
		},
		async capture() {
			const listing = await this.list();
			if (listing.error) return listing;
			const files = new Map<string, Uint8Array>();
			const unreadable: { path: string; error: FileError }[] = [];
			for (const { path } of listing.data.files) {
				if (!isPortablePath(path)) continue;
				try {
					files.set(path, new Uint8Array(await readFile(absolute(path))));
				} catch (cause) {
					// A file removed during enumeration is simply absent from this capture.
					if (codeOf(cause) === 'ENOENT') continue;
					unreadable.push({
						path,
						error: FileError.Io({ path, operation: 'read', cause }).error,
					});
				}
			}
			const captured: CapturedFiles = { files, unreadable };
			return Ok(captured);
		},
	};
}

/** Resolve the folder root once, refusing a path that is not a directory. */
export async function resolveNativeRoot(root: string): Promise<string> {
	const resolved = await realpath(root);
	const stats = await lstat(resolved);
	if (!stats.isDirectory())
		throw new Error(`The native folder root '${root}' is not a directory.`);
	return resolved;
}
