/**
 * The throwaway filesystem one Git transfer runs over.
 *
 * isomorphic-git only speaks to files, so a transfer needs somewhere to put a
 * bare repository. This keeps it in memory: nothing outlives `clear()` or the
 * last reference, and nothing is shared between transfers. Failures carry
 * Node's `code`, which isomorphic-git reads (`ENOENT`, `EEXIST`, `ENOTDIR`).
 */

type Node = { kind: 'dir'; children: Map<string, Node> } | FileNode;
type FileNode = { kind: 'file'; bytes: Uint8Array };

const encoder = new TextEncoder();
const decoder = new TextDecoder();

function fsError(code: string, path: string): Error {
	return Object.assign(new Error(`${code}: ${path}`), { code });
}

function segments(path: string) {
	return path.split('/').filter((part) => part !== '' && part !== '.');
}

function encodingOf(options: unknown): string | undefined {
	if (typeof options === 'string') return options;
	if (typeof options === 'object' && options !== null)
		return (options as { encoding?: string }).encoding ?? undefined;
	return undefined;
}

function statsOf(node: Node) {
	const directory = node.kind === 'dir';
	return {
		type: directory ? 'dir' : 'file',
		mode: directory ? 0o40755 : 0o100644,
		size: directory ? 0 : node.bytes.length,
		ino: 0,
		mtimeMs: 0,
		ctimeMs: 0,
		uid: 0,
		gid: 0,
		dev: 0,
		isFile: () => !directory,
		isDirectory: () => directory,
		isSymbolicLink: () => false,
	};
}

export function createScratchFs() {
	let root: Node = { kind: 'dir', children: new Map() };

	function find(path: string): Node | undefined {
		let node: Node = root;
		for (const part of segments(path)) {
			if (node.kind !== 'dir') return undefined;
			const child = node.children.get(part);
			if (child === undefined) return undefined;
			node = child;
		}
		return node;
	}

	/** The directory a new entry at `path` lands in, and the entry's name. */
	function parentOf(path: string) {
		const parts = segments(path);
		const name = parts.pop();
		if (name === undefined) throw fsError('EINVAL', path);
		const parent = find(`/${parts.join('/')}`);
		if (parent === undefined) throw fsError('ENOENT', path);
		if (parent.kind !== 'dir') throw fsError('ENOTDIR', path);
		return { parent, name };
	}

	function present(path: string) {
		const node = find(path);
		if (node === undefined) throw fsError('ENOENT', path);
		return node;
	}

	const promises = {
		async readFile(path: string, options?: unknown) {
			const node = present(path);
			if (node.kind === 'dir') throw fsError('EISDIR', path);
			return encodingOf(options) === undefined
				? node.bytes
				: decoder.decode(node.bytes);
		},
		async writeFile(path: string, data: Uint8Array | string) {
			const { parent, name } = parentOf(path);
			if (parent.children.get(name)?.kind === 'dir')
				throw fsError('EISDIR', path);
			// Callers may reuse their buffer; the file must not change with it.
			const bytes =
				typeof data === 'string' ? encoder.encode(data) : data.slice();
			parent.children.set(name, { kind: 'file', bytes });
		},
		async unlink(path: string) {
			const node = present(path);
			if (node.kind === 'dir') throw fsError('EISDIR', path);
			const { parent, name } = parentOf(path);
			parent.children.delete(name);
		},
		async readdir(path: string) {
			const node = present(path);
			if (node.kind !== 'dir') throw fsError('ENOTDIR', path);
			return [...node.children.keys()];
		},
		async mkdir(path: string) {
			const { parent, name } = parentOf(path);
			if (parent.children.has(name)) throw fsError('EEXIST', path);
			parent.children.set(name, { kind: 'dir', children: new Map() });
		},
		async rmdir(path: string) {
			const node = present(path);
			if (node.kind !== 'dir') throw fsError('ENOTDIR', path);
			if (node.children.size > 0) throw fsError('ENOTEMPTY', path);
			const { parent, name } = parentOf(path);
			parent.children.delete(name);
		},
		async stat(path: string) {
			return statsOf(present(path));
		},
		async lstat(path: string) {
			return statsOf(present(path));
		},
		// A bare repository the transfer builds has no links. isomorphic-git binds
		// both methods up front, so they exist and refuse.
		async readlink(path: string): Promise<never> {
			throw fsError('EINVAL', path);
		},
		async symlink(_target: string, path: string): Promise<never> {
			throw fsError('EPERM', path);
		},
	};

	return {
		promises,
		/** Drops every file so the transfer's bytes can be collected at once. */
		clear() {
			root = { kind: 'dir', children: new Map() };
		},
	};
}

export type ScratchFs = ReturnType<typeof createScratchFs>;
