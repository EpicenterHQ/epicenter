/**
 * Native history requests over a disposable directory. Each request constructs
 * its own backend and holds the production history lock. File saves use the
 * native Folder independently; there is no history handle or edit notification.
 */
import { realpath } from 'node:fs/promises';
import { Err, Ok } from 'wellcrafted/result';
import { expectOk } from 'wellcrafted/testing';
import { nodeDirectoryPrimitives } from './directory-node.js';
import type { DirectoryPrimitives } from './directory-primitives.js';
import { createDirectoryStorage } from './directory-store.js';
import { createFolder } from './folder.js';
import type { GitBackend, GitRemote } from './git/backend.js';
import type { GitCredentials } from './git/http.js';
import { createNativeGitBackend } from './git/native-backend.js';
import { runNativeHistory } from './git/native-history.js';
import { createGitRunner } from './git/native-host.js';
import type { Author } from './git/objects.js';
import { scratch } from './git-http.test-support.js';
import type { HistoryRequest } from './history-wire.js';
import { scratchDirectory } from './native/directory.js';
import type { FileContent } from './shared/merge.js';
import { storageHost } from './storage.js';

export async function openDirectoryHistory({
	root,
	git: { author, credentials },
	primitives: files = nodeDirectoryPrimitives,
	beforeGit,
}: {
	readonly root: string;
	readonly git: {
		readonly author: Author;
		readonly credentials?: GitCredentials;
	};
	/** The file system calls, for a test that plays another writer or a crash. */
	readonly primitives?: DirectoryPrimitives;
	/** Runs before each `git` command this history runs. */
	readonly beforeGit?: (args: readonly string[]) => Promise<void>;
}) {
	const storage = createDirectoryStorage({
		root,
		primitives: files,
		scratch: scratchDirectory(root),
		hold: { lock: <T>(work: () => Promise<T>) => work(), held: files },
	});
	const system = createGitRunner(root);
	const run: typeof system = async (args, options) => {
		await beforeGit?.(args);
		return system(args, options);
	};
	const folder = expectOk(
		await createFolder(storageHost(storage), { tables: {} }),
	);
	return {
		root,
		storage,
		request<TRequest extends HistoryRequest>(request: TRequest) {
			return runNativeHistory({
				rootPath: root,
				host: { run, files },
				boundary: storage,
				author,
				credentials,
				request,
			});
		},
		/** Replace the file at `path` with `to`, or remove it for `null`. */
		write: async (path: string, to: FileContent | null) => {
			const saved =
				to === null ? await folder.delete(path) : await folder.write(path, to);
			return saved.error === null ? Ok(undefined) : Err(saved.error);
		},
		files: { read: (path: string) => storage.read(path) },
		close: async () => {
			await folder.close();
		},
	};
}

export type DirectoryHistory = Awaited<ReturnType<typeof openDirectoryHistory>>;

/**
 * Raw storage and Git over a fresh directory, for tests of the history's
 * parts: `backend()` makes its repository, with `remote` set first when
 * given, and nothing else is created.
 */
export async function rawDirectoryFolder(prefix = 'raw-directory-') {
	const root = await realpath(await scratch(prefix));
	const files = nodeDirectoryPrimitives;
	const boundary = createDirectoryStorage({
		root,
		primitives: files,
		scratch: scratchDirectory(root),
		hold: { lock: <T>(work: () => Promise<T>) => work(), held: files },
	});
	return {
		root,
		boundary,
		async backend({
			branch = 'main',
			remote,
		}: {
			branch?: string;
			remote?: GitRemote;
		} = {}): Promise<GitBackend> {
			const backend = await createNativeGitBackend({
				root,
				branch,
				host: { run: createGitRunner(root), files },
			});
			await backend.createRepository?.();
			if (remote !== undefined) await backend.setRemote(remote.url);
			return backend;
		},
	};
}
