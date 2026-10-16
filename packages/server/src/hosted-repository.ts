/**
 * One hosted repository opened as this server (ADR-0550): its history copied
 * into memory through the `GitHost` store's own smart HTTP, then read, or
 * extended by one commit pushed back the same way.
 *
 * Nothing here reaches the network or a disk. isomorphic-git speaks to
 * `GitHost.serve` in process, so the disk store and the Artifacts store are
 * read and written through the one interface hosted Git already authorizes
 * for, and a client's credential never reaches storage. The copy lives for
 * one call and holds only Git objects: no working tree, no index.
 *
 * A write merges nothing. It is refused when its base is not the head it
 * fetched, and refused again by the push when another writer moved the head
 * in between; the client reads again and writes again.
 */
import git, { type HttpClient, type PromiseFsClient } from 'isomorphic-git';
import { defineErrors, type InferErrors } from 'wellcrafted/error';
import { Ok, type Result } from 'wellcrafted/result';
import type { GitHost, GitService } from './routes/git.js';

const GITDIR = '/repository.git';
/** isomorphic-git needs a URL; the store, not this host, answers it. */
const STORE_URL = 'https://store.invalid/repository.git';
const DEFAULT_BRANCH = 'refs/heads/main';
const FORWARDED_HEADERS = ['content-type', 'accept', 'git-protocol'];
const LFS_POINTER = 'version https://git-lfs.github.com/spec/v1\n';

function fsError(code: string, path: string): Error {
	return Object.assign(new Error(`${code}: ${path}`), { code });
}

/** A file system in memory, holding only what isomorphic-git writes under its gitdir. */
function memoryFs(): PromiseFsClient {
	const files = new Map<string, Uint8Array>();
	const directories = new Set<string>(['/']);
	const parentOf = (path: string) =>
		path.slice(0, path.lastIndexOf('/')) || '/';
	const ensureParents = (path: string) => {
		for (
			let parent = parentOf(path);
			!directories.has(parent);
			parent = parentOf(parent)
		)
			directories.add(parent);
	};
	const stat = async (path: string) => {
		const file = files.get(path);
		const directory = directories.has(path);
		if (file === undefined && !directory) throw fsError('ENOENT', path);
		return {
			type: directory ? 'dir' : 'file',
			mode: directory ? 0o40755 : 0o100644,
			size: file?.byteLength ?? 0,
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
	};
	return {
		promises: {
			async readFile(path: string, options?: unknown) {
				const file = files.get(path);
				if (file === undefined)
					throw fsError(directories.has(path) ? 'EISDIR' : 'ENOENT', path);
				const encoding =
					typeof options === 'string'
						? options
						: (options as { encoding?: string } | undefined)?.encoding;
				return encoding === 'utf8' ? new TextDecoder().decode(file) : file;
			},
			async writeFile(path: string, data: Uint8Array | string) {
				ensureParents(path);
				files.set(
					path,
					typeof data === 'string'
						? new TextEncoder().encode(data)
						: new Uint8Array(data),
				);
			},
			async unlink(path: string) {
				if (!files.delete(path)) throw fsError('ENOENT', path);
			},
			async readdir(path: string) {
				if (!directories.has(path))
					throw fsError(files.has(path) ? 'ENOTDIR' : 'ENOENT', path);
				const prefix = path === '/' ? '/' : `${path}/`;
				const names = new Set<string>();
				for (const entry of [...files.keys(), ...directories])
					if (entry !== path && entry.startsWith(prefix))
						names.add(entry.slice(prefix.length).split('/')[0] ?? '');
				names.delete('');
				return [...names];
			},
			async mkdir(path: string) {
				if (directories.has(path) || files.has(path))
					throw fsError('EEXIST', path);
				ensureParents(path);
				directories.add(path);
			},
			async rmdir(path: string) {
				if (!directories.delete(path)) throw fsError('ENOENT', path);
			},
			stat,
			lstat: stat,
			async readlink(path: string): Promise<never> {
				throw fsError('EINVAL', path);
			},
			async symlink(_target: string, path: string): Promise<never> {
				throw fsError('EPERM', path);
			},
		},
	};
}

async function collect(body: AsyncIterableIterator<Uint8Array>) {
	const chunks: Uint8Array[] = [];
	for await (const chunk of body) chunks.push(chunk);
	const bytes = new Uint8Array(
		chunks.reduce((size, chunk) => size + chunk.byteLength, 0),
	);
	let offset = 0;
	for (const chunk of chunks) {
		bytes.set(chunk, offset);
		offset += chunk.byteLength;
	}
	return bytes;
}

async function* chunksOf(stream: ReadableStream<Uint8Array>) {
	const reader = stream.getReader();
	try {
		while (true) {
			const { done, value } = await reader.read();
			if (done) return;
			yield value;
		}
	} finally {
		reader.releaseLock();
	}
}

function headerRecord(headers: Headers) {
	const record: Record<string, string> = {};
	headers.forEach((value, name) => {
		record[name] = value;
	});
	return record;
}

/** Smart HTTP answered by the store in process, as this server's own request. */
function storeHttp(
	host: GitHost,
	repositoryId: string,
	accountId: string,
	signal: AbortSignal,
): HttpClient {
	return {
		async request({ url, method = 'GET', headers = {}, body }) {
			const { pathname, searchParams } = new URL(url);
			const advertisement = pathname.endsWith('/info/refs');
			const service = advertisement
				? searchParams.get('service')
				: pathname.slice(pathname.lastIndexOf('/') + 1);
			if (service !== 'git-upload-pack' && service !== 'git-receive-pack')
				throw new Error(`not a smart HTTP request: ${method} ${pathname}`);
			const forwarded = new Headers();
			for (const [name, value] of Object.entries(headers))
				if (FORWARDED_HEADERS.includes(name.toLowerCase()))
					forwarded.set(name, value);
			const payload = body === undefined ? null : await collect(body);
			const response = await host.serve(repositoryId, {
				service: service satisfies GitService,
				advertisement,
				headers: forwarded,
				body:
					payload === null
						? null
						: new Response(payload as Uint8Array<ArrayBuffer>).body,
				signal,
				accountId,
			});
			return {
				url,
				method,
				statusCode: response.status,
				statusMessage: response.statusText,
				headers: headerRecord(response.headers),
				body: response.body === null ? undefined : chunksOf(response.body),
			};
		},
	};
}

/** One file as `read_files` answers it. */
export type FileContent =
	| { path: string; content: string }
	| { path: string; lfs: { oid: string; size: number }; pointer: string }
	| { path: string; binary: true; size: number }
	| { path: string; missing: true };

export type CommitSummary = {
	commit: string;
	message: string;
	author: { name: string; email: string; date: string };
};

/** One change in a write: a file's new text, or its removal. */
export type FileChange =
	| { path: string; content: string }
	| { path: string; delete: true };

/** Why a write made no commit. */
export const RepositoryWriteError = defineErrors({
	Stale: ({ base, head }: { base: string | null; head: string | null }) => ({
		message: `The base ${base ?? '(none)'} is not the current head ${head ?? '(an empty repository)'}. Read again, then write again.`,
		base,
		head,
	}),
	InvalidChange: ({ path, reason }: { path: string; reason: string }) => ({
		message: `${path}: ${reason}`,
		path,
	}),
	PushRefused: ({ reason }: { reason: string }) => ({
		message: `Storage refused the commit: ${reason}`,
	}),
});
export type RepositoryWriteError = InferErrors<typeof RepositoryWriteError>;

/** Whether `path` is a file path a commit may hold: relative, no `.`, `..`, or `.git` segment. */
function isFilePath(path: string): boolean {
	if (path === '' || path.startsWith('/') || path.endsWith('/')) return false;
	return path
		.split('/')
		.every(
			(segment) =>
				segment !== '' &&
				segment !== '.' &&
				segment !== '..' &&
				segment.toLowerCase() !== '.git' &&
				!segment.includes('\0'),
		);
}

function summarize(entry: Awaited<ReturnType<typeof git.log>>[number]) {
	const { author, message } = entry.commit;
	return {
		commit: entry.oid,
		message: message.trimEnd(),
		author: {
			name: author.name,
			email: author.email,
			date: new Date(author.timestamp * 1000).toISOString(),
		},
	} satisfies CommitSummary;
}

/**
 * Copy repository `repositoryId` from `host` into memory and return what can
 * be read or written there. Throws when the store cannot be reached.
 */
export async function openHostedRepository(
	host: GitHost,
	{
		repositoryId,
		accountId,
		signal,
	}: { repositoryId: string; accountId: string; signal: AbortSignal },
) {
	const fs = memoryFs();
	const http = storeHttp(host, repositoryId, accountId, signal);
	const cache = {};
	await git.init({ fs, gitdir: GITDIR, bare: true, defaultBranch: 'main' });
	await git.addRemote({ fs, gitdir: GITDIR, remote: 'origin', url: STORE_URL });
	const advertised = await git.getRemoteInfo2({
		http,
		url: STORE_URL,
		protocolVersion: 1,
	});
	const symbolicHead = advertised.refs?.find((ref) => ref.ref === 'HEAD');
	const branch = symbolicHead?.target ?? DEFAULT_BRANCH;
	const advertisedHead =
		advertised.refs?.find((ref) => ref.ref === branch)?.oid ?? null;
	let head: string | null = null;
	if (advertisedHead !== null) {
		const fetched = await git.fetch({
			fs,
			http,
			gitdir: GITDIR,
			cache,
			remote: 'origin',
			ref: branch.replace(/^refs\/heads\//, ''),
			singleBranch: true,
			tags: false,
		});
		head = fetched.fetchHead;
	}
	const at = (commit: string | undefined) => commit ?? head;

	/** The file paths at `commit`, all of them or those under `prefix`. */
	async function listFiles(commit: string | null, prefix = '') {
		if (commit === null) return [];
		const paths = await git.listFiles({
			fs,
			gitdir: GITDIR,
			cache,
			ref: commit,
		});
		const under = prefix.replace(/\/+$/, '');
		return under === ''
			? paths
			: paths.filter((path) => path === under || path.startsWith(`${under}/`));
	}

	async function readFile(commit: string, path: string): Promise<FileContent> {
		let blob: Uint8Array;
		try {
			({ blob } = await git.readBlob({
				fs,
				gitdir: GITDIR,
				cache,
				oid: commit,
				filepath: path,
			}));
		} catch {
			return { path, missing: true };
		}
		let text: string;
		try {
			text = new TextDecoder('utf-8', { fatal: true }).decode(blob);
		} catch {
			return { path, binary: true, size: blob.byteLength };
		}
		if (text.startsWith(LFS_POINTER)) {
			const oid = /^oid sha256:([0-9a-f]{64})$/m.exec(text)?.[1];
			const size = /^size (\d+)$/m.exec(text)?.[1];
			if (oid !== undefined && size !== undefined)
				return {
					path,
					lfs: { oid: `sha256:${oid}`, size: Number(size) },
					pointer: text,
				};
		}
		return { path, content: text };
	}

	/**
	 * The tree `treeOid` with `changes` applied, keyed by path below it, or
	 * null when nothing is left in it.
	 */
	async function applyChanges(
		treeOid: string | null,
		changes: Map<string, string | null>,
		prefix: string,
	): Promise<Result<string | null, RepositoryWriteError>> {
		const entries = new Map(
			treeOid === null
				? []
				: (
						await git.readTree({ fs, gitdir: GITDIR, cache, oid: treeOid })
					).tree.map((entry) => [entry.path, entry]),
		);
		const below = new Map<string, Map<string, string | null>>();
		for (const [path, blob] of changes) {
			const slash = path.indexOf('/');
			if (slash !== -1) {
				const name = path.slice(0, slash);
				let nested = below.get(name);
				if (nested === undefined) {
					nested = new Map();
					below.set(name, nested);
				}
				nested.set(path.slice(slash + 1), blob);
				continue;
			}
			const existing = entries.get(path);
			const full = `${prefix}${path}`;
			if (existing?.type === 'tree')
				return RepositoryWriteError.InvalidChange({
					path: full,
					reason: 'is a directory',
				});
			if (blob === null) {
				if (existing === undefined)
					return RepositoryWriteError.InvalidChange({
						path: full,
						reason: 'does not exist at the base, so it cannot be deleted',
					});
				entries.delete(path);
				continue;
			}
			entries.set(path, {
				path,
				type: 'blob',
				oid: blob,
				// Keep an executable file executable; anything new is a plain file.
				mode:
					existing?.mode === '100755' || existing?.mode === '100644'
						? existing.mode
						: '100644',
			});
		}
		for (const [name, nested] of below) {
			const existing = entries.get(name);
			if (existing !== undefined && existing.type !== 'tree')
				return RepositoryWriteError.InvalidChange({
					path: `${prefix}${name}`,
					reason: 'is a file, so nothing can be written below it',
				});
			const tree = await applyChanges(
				existing?.oid ?? null,
				nested,
				`${prefix}${name}/`,
			);
			if (tree.error !== null) return tree;
			if (tree.data === null) entries.delete(name);
			else
				entries.set(name, {
					path: name,
					type: 'tree',
					oid: tree.data,
					mode: '040000',
				});
		}
		if (entries.size === 0 && prefix !== '') return Ok(null);
		return Ok(
			await git.writeTree({ fs, gitdir: GITDIR, tree: [...entries.values()] }),
		);
	}

	return {
		/** The default branch's head commit, or null for an empty repository. */
		head,
		/** The branch a write moves, `refs/heads/<name>`. */
		branch,

		/** The file paths at `commit` (the head by default), those under `prefix` when given. */
		listFiles: (prefix?: string, commit?: string) =>
			listFiles(at(commit), prefix),

		/** The content of each of `paths` at `commit` (the head by default). */
		async readFiles(paths: string[], commit?: string) {
			const target = at(commit);
			if (target === null)
				return paths.map((path): FileContent => ({ path, missing: true }));
			return Promise.all(paths.map((path) => readFile(target, path)));
		},

		/** The commits from `commit` (the head by default) back, those touching `path` when given. */
		async history({
			commit,
			path,
			limit,
		}: {
			commit?: string;
			path?: string;
			limit: number;
		}) {
			const target = at(commit);
			if (target === null) return [];
			const entries = await git.log({
				fs,
				gitdir: GITDIR,
				cache,
				ref: target,
				depth: limit,
				...(path === undefined ? {} : { filepath: path, force: true }),
			});
			return entries.map(summarize);
		},

		/**
		 * One commit of `changes` on `base`, pushed to the default branch.
		 * Refused when `base` is not the head this copy fetched, or when the
		 * push finds the head moved since.
		 */
		async commit({
			base,
			message,
			changes,
			author,
		}: {
			base: string | null;
			message: string;
			changes: FileChange[];
			author: { name: string; email: string };
		}): Promise<Result<{ commit: string }, RepositoryWriteError>> {
			if (base !== head) return RepositoryWriteError.Stale({ base, head });
			const blobs = new Map<string, string | null>();
			for (const change of changes) {
				if (!isFilePath(change.path))
					return RepositoryWriteError.InvalidChange({
						path: change.path,
						reason:
							"is not a file path: use '/'-separated names with no '.', '..', or '.git' segment",
					});
				if (blobs.has(change.path))
					return RepositoryWriteError.InvalidChange({
						path: change.path,
						reason: 'appears in more than one change',
					});
				blobs.set(
					change.path,
					'delete' in change
						? null
						: await git.writeBlob({
								fs,
								gitdir: GITDIR,
								blob: new TextEncoder().encode(change.content),
							}),
				);
			}
			const baseTree =
				base === null
					? null
					: (await git.readCommit({ fs, gitdir: GITDIR, cache, oid: base }))
							.commit.tree;
			const tree = await applyChanges(baseTree, blobs, '');
			if (tree.error !== null) return tree;
			const signature = {
				...author,
				timestamp: Math.floor(Date.now() / 1000),
				timezoneOffset: 0,
			};
			const commit = await git.writeCommit({
				fs,
				gitdir: GITDIR,
				commit: {
					message: message.endsWith('\n') ? message : `${message}\n`,
					tree:
						tree.data ??
						(await git.writeTree({ fs, gitdir: GITDIR, tree: [] })),
					parent: base === null ? [] : [base],
					author: signature,
					committer: signature,
				},
			});
			const local = 'refs/heads/mcp-write';
			await git.writeRef({
				fs,
				gitdir: GITDIR,
				ref: local,
				value: commit,
				force: true,
			});
			let pushed: Awaited<ReturnType<typeof git.push>>;
			try {
				pushed = await git.push({
					fs,
					http,
					gitdir: GITDIR,
					cache,
					url: STORE_URL,
					ref: local,
					remoteRef: branch,
				});
			} catch (cause) {
				// isomorphic-git refuses a push that is not a fast-forward of what
				// it just read from the store: another writer moved the head.
				if ((cause as { code?: string }).code === 'PushRejectedError') {
					const now = await git.getRemoteInfo2({
						http,
						url: STORE_URL,
						protocolVersion: 1,
					});
					return RepositoryWriteError.Stale({
						base,
						head: now.refs?.find((ref) => ref.ref === branch)?.oid ?? null,
					});
				}
				throw cause;
			}
			const outcome = pushed.refs[branch];
			if (!pushed.ok || outcome?.ok === false)
				return RepositoryWriteError.PushRefused({
					reason: outcome?.error ?? pushed.error ?? 'no reason given',
				});
			return Ok({ commit });
		},
	};
}

export type HostedRepository = Awaited<ReturnType<typeof openHostedRepository>>;
