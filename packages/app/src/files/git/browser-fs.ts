/**
 * The filesystem isomorphic-git sees in a browser folder.
 *
 * `/git/...` is private Git state in the `git` object store. `/files/...` is
 * a read-only view of the portable files, so `statusMatrix`, `add`, and
 * `resetIndex` observe the same bytes the app and shell edit. Git can never
 * write a portable path: there is no second browser working tree.
 *
 * Each session buffers its writes and publishes them in one transaction,
 * optionally together with file changes and a conditional ref update.
 */
import type { PromiseFsClient } from 'isomorphic-git';
import {
	type IndexedDbEnvironment,
	type InventoryRecord,
	prefixRange,
	request,
	STORES,
} from '../browser-store.js';

export const GITDIR = '/git';
export const WORKDIR = '/files';

type StoredGitValue = Uint8Array;

function failure(code: string, path: string): Error {
	return Object.assign(new Error(`${code}: ${path}`), { code });
}

function statsFor(
	kind: 'file' | 'directory',
	size: number,
	record?: Pick<InventoryRecord, 'mtimeMs' | 'ino'>,
) {
	const mtimeMs = record?.mtimeMs ?? 0;
	return {
		isFile: () => kind === 'file',
		isDirectory: () => kind === 'directory',
		isSymbolicLink: () => false,
		mode: kind === 'file' ? 0o100644 : 0o40755,
		size,
		mtimeMs,
		ctimeMs: mtimeMs,
		uid: 0,
		gid: 0,
		ino: record?.ino ?? 0,
		dev: 0,
	};
}

const decoder = new TextDecoder();
const encoder = new TextEncoder();

export type GitSession = {
	readonly fs: PromiseFsClient;
	/** Writes to the git store in an already open transaction that includes it. */
	flushInto(tx: IDBTransaction): void;
	/** Publishes buffered writes in their own transaction. */
	flush(): Promise<void>;
};

export function createGitSession(
	db: IDBDatabase,
	environment: IndexedDbEnvironment,
): GitSession {
	const pending = new Map<string, StoredGitValue | null>();

	const normalize = (path: string) => {
		const parts: string[] = [];
		for (const part of path.split('/')) {
			if (part === '' || part === '.') continue;
			if (part === '..') parts.pop();
			else parts.push(part);
		}
		return `/${parts.join('/')}`;
	};
	const isGit = (path: string) =>
		path === GITDIR || path.startsWith(`${GITDIR}/`);
	const isWork = (path: string) =>
		path === WORKDIR || path.startsWith(`${WORKDIR}/`);
	const relative = (path: string) =>
		path === WORKDIR ? '' : path.slice(WORKDIR.length + 1);

	async function gitValue(path: string): Promise<StoredGitValue | undefined> {
		if (pending.has(path)) return pending.get(path) ?? undefined;
		return (await request(
			db.transaction(STORES.git).objectStore(STORES.git).get(path),
		)) as StoredGitValue | undefined;
	}

	async function gitChildren(path: string): Promise<string[]> {
		const prefix = `${path}/`;
		const stored = (await request(
			db
				.transaction(STORES.git)
				.objectStore(STORES.git)
				.getAllKeys(prefixRange(environment, prefix)),
		)) as string[];
		const keys = new Set(stored);
		for (const [key, value] of pending) {
			if (!key.startsWith(prefix)) continue;
			if (value === null) keys.delete(key);
			else keys.add(key);
		}
		const names = new Set<string>();
		for (const key of keys) names.add(key.slice(prefix.length).split('/')[0]!);
		return [...names];
	}

	async function workRecord(path: string) {
		const tx = db.transaction(
			[STORES.inventory, STORES.contents, STORES.directories],
			'readonly',
		);
		return (await request(tx.objectStore(STORES.inventory).get(path))) as
			| InventoryRecord
			| undefined;
	}

	async function workChildren(path: string): Promise<string[] | undefined> {
		const prefix = path === '' ? '' : `${path}/`;
		const tx = db.transaction(
			[STORES.inventory, STORES.directories],
			'readonly',
		);
		const range = prefix === '' ? undefined : prefixRange(environment, prefix);
		const files = (await request(
			tx.objectStore(STORES.inventory).getAllKeys(range),
		)) as string[];
		const directories = (await request(
			tx.objectStore(STORES.directories).getAllKeys(range),
		)) as string[];
		if (path !== '' && files.length === 0 && directories.length === 0) {
			const explicit = await request(
				tx.objectStore(STORES.directories).get(path),
			);
			if (explicit === undefined) return undefined;
		}
		const names = new Set<string>();
		for (const key of [...files, ...directories]) {
			const rest = key.slice(prefix.length);
			if (rest !== '') names.add(rest.split('/')[0]!);
		}
		return [...names];
	}

	async function stat(rawPath: string) {
		const path = normalize(rawPath);
		if (isGit(path)) {
			const value = await gitValue(path);
			if (value !== undefined) return statsFor('file', value.byteLength);
			if (path === GITDIR || (await gitChildren(path)).length > 0)
				return statsFor('directory', 0);
			throw failure('ENOENT', path);
		}
		if (isWork(path)) {
			const rel = relative(path);
			if (rel !== '') {
				const record = await workRecord(rel);
				if (record !== undefined) return statsFor('file', record.size, record);
			}
			if ((await workChildren(rel)) !== undefined)
				return statsFor('directory', 0);
			throw failure('ENOENT', path);
		}
		if (path === '/') return statsFor('directory', 0);
		throw failure('ENOENT', path);
	}

	const promises = {
		async readFile(rawPath?: string, options?: string | { encoding?: string }) {
			if (rawPath === undefined) throw failure('EINVAL', '');
			const path = normalize(rawPath);
			let value: Uint8Array | undefined;
			if (isGit(path)) value = await gitValue(path);
			else if (isWork(path)) {
				const tx = db.transaction(STORES.contents, 'readonly');
				value = (await request(
					tx.objectStore(STORES.contents).get(relative(path)),
				)) as Uint8Array | undefined;
			}
			if (value === undefined) throw failure('ENOENT', path);
			const encoding =
				typeof options === 'string' ? options : options?.encoding;
			return encoding ? decoder.decode(value) : value;
		},
		async writeFile(rawPath: string, data: Uint8Array | string) {
			const path = normalize(rawPath);
			if (!isGit(path)) throw failure('EPERM', path);
			pending.set(
				path,
				typeof data === 'string' ? encoder.encode(data) : new Uint8Array(data),
			);
		},
		async unlink(rawPath: string) {
			const path = normalize(rawPath);
			if (!isGit(path)) throw failure('EPERM', path);
			if ((await gitValue(path)) === undefined) throw failure('ENOENT', path);
			pending.set(path, null);
		},
		async readdir(rawPath: string) {
			const path = normalize(rawPath);
			if (isGit(path)) {
				const value = await gitValue(path);
				if (value !== undefined) throw failure('ENOTDIR', path);
				return gitChildren(path);
			}
			if (isWork(path)) {
				const names = await workChildren(relative(path));
				if (names === undefined) throw failure('ENOENT', path);
				return names;
			}
			if (path === '/') return ['files', 'git'];
			throw failure('ENOENT', path);
		},
		async mkdir(rawPath: string) {
			const path = normalize(rawPath);
			if (!isGit(path)) throw failure('EPERM', path);
		},
		async rmdir(rawPath: string) {
			const path = normalize(rawPath);
			if (!isGit(path)) throw failure('EPERM', path);
		},
		stat,
		lstat: stat,
		async readlink(rawPath: string): Promise<string> {
			throw failure('EINVAL', rawPath);
		},
		async symlink(_target: string, rawPath: string) {
			throw failure('EPERM', rawPath);
		},
		async chmod() {},
	};

	return {
		fs: { promises } as unknown as PromiseFsClient,
		flushInto(tx) {
			const store = tx.objectStore(STORES.git);
			for (const [key, value] of pending) {
				if (value === null) store.delete(key);
				else store.put(value, key);
			}
			pending.clear();
		},
		async flush() {
			if (pending.size === 0) return;
			const tx = db.transaction(STORES.git, 'readwrite', {
				durability: 'strict',
			});
			const done = new Promise<void>((resolve, reject) => {
				tx.oncomplete = () => resolve();
				tx.onabort = () => reject(tx.error ?? new Error('Git write aborted'));
				tx.onerror = () => reject(tx.error);
			});
			this.flushInto(tx);
			await done;
		},
	};
}
