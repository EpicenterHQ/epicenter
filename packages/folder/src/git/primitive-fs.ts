/**
 * The `fs` isomorphic-git asks for, over directory primitives, for the
 * object reads and writes the native backend leaves to it.
 *
 * Every write lands whole: its bytes go to a temporary file beside the path,
 * which is then renamed over it, so another Git reader never meets an empty
 * or partial object. Failures carry Node's `code`, which isomorphic-git
 * reads (`ENOENT` for a missing path, `EEXIST`, `ENOTDIR`).
 */
import type { PromiseFsClient } from 'isomorphic-git';
import type { DirectoryPrimitives } from '../directory-handle.js';

function fsError(code: string, path: string): Error {
	return Object.assign(new Error(`${code}: ${path}`), { code });
}

const decoder = new TextDecoder();
const encoder = new TextEncoder();

function encodingOf(options: unknown): string | undefined {
	if (typeof options === 'string') return options;
	if (typeof options === 'object' && options !== null)
		return (options as { encoding?: string }).encoding;
	return undefined;
}

let temporaryCounter = 0;

/** Inflate a loose object as isomorphic-git deflates it (zlib). */
async function inflate(bytes: Uint8Array): Promise<Uint8Array> {
	const stream = new Blob([bytes as Uint8Array<ArrayBuffer>])
		.stream()
		.pipeThrough(new DecompressionStream('deflate'));
	return new Uint8Array(await new Response(stream).arrayBuffer());
}

/** A loose object's path below `gitdir`, as `[pair, rest]`, or `undefined`. */
function objectName(gitdir: string, path: string): string | undefined {
	const match = path
		.slice(gitdir.length)
		.match(/^\/objects\/([0-9a-f]{2})\/([0-9a-f]{38})$/);
	return match === null ? undefined : `${match[1]}${match[2]}`;
}

/**
 * `objects` stores each loose object instead of `fs`: given its type and
 * content, it writes the object and returns the name Git gave it. Over a
 * directory another Git program shares, that is `git hash-object -w`, which
 * names and checks the object itself, so no object file is ever written by
 * hand.
 */
export type ObjectStore = {
	readonly gitdir: string;
	write(type: string, content: Uint8Array): Promise<string>;
};

export function primitiveFs(
	primitives: DirectoryPrimitives,
	objects?: ObjectStore,
): PromiseFsClient {
	async function statOf(path: string) {
		const found = await primitives.lstat(path);
		if (found === undefined) throw fsError('ENOENT', path);
		const mode =
			found.mode ??
			(found.kind === 'directory'
				? 0o40755
				: found.kind === 'file'
					? 0o100644
					: 0);
		return {
			type: found.kind === 'directory' ? 'dir' : 'file',
			mode,
			size: found.size,
			ino: 0,
			mtimeMs: 0,
			ctimeMs: 0,
			uid: 0,
			gid: 0,
			dev: 0,
			isFile: () => found.kind === 'file',
			isDirectory: () => found.kind === 'directory',
			isSymbolicLink: () => found.kind === 'link',
		};
	}

	const promises = {
		async readFile(path: string, options?: unknown) {
			const found = await primitives.lstat(path);
			if (found === undefined) throw fsError('ENOENT', path);
			if (found.kind === 'directory') throw fsError('EISDIR', path);
			const bytes = await primitives.readFile(path);
			return encodingOf(options) === 'utf8' ? decoder.decode(bytes) : bytes;
		},
		async writeFile(path: string, data: Uint8Array | string) {
			const bytes = typeof data === 'string' ? encoder.encode(data) : data;
			const name =
				objects === undefined ? undefined : objectName(objects.gitdir, path);
			if (objects !== undefined && name !== undefined) {
				const raw = await inflate(bytes);
				const space = raw.indexOf(0x20);
				const nul = raw.indexOf(0);
				const type = decoder.decode(raw.subarray(0, space));
				const written = await objects.write(type, raw.subarray(nul + 1));
				if (written !== name)
					throw new Error(
						`Git stored the object as ${written}, not ${name}; nothing names it`,
					);
				return;
			}
			const temporary = `${path}.tmp-${Date.now().toString(36)}-${(temporaryCounter++).toString(36)}`;
			await primitives.writeFile(temporary, bytes, { createNew: true });
			try {
				await primitives.rename(temporary, path);
			} catch (cause) {
				await primitives.remove(temporary).catch(() => {});
				throw cause;
			}
		},
		async unlink(path: string) {
			if ((await primitives.lstat(path)) === undefined)
				throw fsError('ENOENT', path);
			await primitives.remove(path);
		},
		async readdir(path: string) {
			const found = await primitives.lstat(path);
			if (found === undefined) throw fsError('ENOENT', path);
			if (found.kind !== 'directory') throw fsError('ENOTDIR', path);
			return (await primitives.readDir(path)).map((entry) => entry.name);
		},
		async mkdir(path: string) {
			// Git makes the object directories it stores into.
			if (
				objects !== undefined &&
				/^\/objects\/[0-9a-f]{2}$/.test(path.slice(objects.gitdir.length))
			)
				return;
			const found = await primitives.lstat(path);
			if (found !== undefined) throw fsError('EEXIST', path);
			await primitives.mkdir(path);
		},
		async rmdir(path: string) {
			if ((await primitives.lstat(path)) === undefined)
				throw fsError('ENOENT', path);
			await primitives.remove(path);
		},
		stat: statOf,
		lstat: statOf,
		async readlink(path: string): Promise<never> {
			throw fsError('EINVAL', path);
		},
		async symlink(_target: string, path: string): Promise<never> {
			throw fsError('EPERM', path);
		},
		async chmod() {},
	};
	return { promises } as unknown as PromiseFsClient;
}
