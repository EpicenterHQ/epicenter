/**
 * Test helper: one directory's history over the system `git`, held open
 * across a test's steps. It is the engine `runHistory` runs one operation of
 * (`bun.ts`), with the directory's files saved through the public native
 * Folder. No `Folder` holds Git (ADR-0636); this is
 * the smallest whole a history test drives.
 *
 * `git` and `sync` are the history; `write` saves a file and marks the
 * history's observations stale, as a save the history did not make does.
 * This process is the directory's only writer, so Sync's save lock is no
 * lock at all.
 */
import { realpath } from 'node:fs/promises';
import { Err, Ok } from 'wellcrafted/result';
import { type Expectation, mayHaveChanged } from './boundary.js';
import { nodeDirectoryPrimitives } from './directory-node.js';
import type { DirectoryPrimitives } from './directory-primitives.js';
import { createDirectoryStorage } from './directory-store.js';
import type { GitBackend, GitRemote } from './git/backend.js';
import type { GitCredentials } from './git/http.js';
import { createNativeGitBackend } from './git/native-backend.js';
import { nativeHistory } from './git/native-history.js';
import { createGitRunner } from './git/native-host.js';
import type { Author } from './git/objects.js';
import { scratch } from './git-http.test-support.js';
import { scratchDirectory } from './native/directory.js';
import { createNativeFolder } from './native/engine.js';
import type { FileContent } from './shared/merge.js';

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
	const landed: string[] = [];
	const history = await nativeHistory({
		rootPath: root,
		host: { run, files },
		boundary: storage,
		author,
		credentials,
		landed: (paths) => landed.push(...paths),
	});
	const noting = {
		async put(path: string, bytes: Uint8Array | null, expected: Expectation) {
			const result = await storage.put(path, bytes, expected);
			if (mayHaveChanged(result)) history.noteEdit();
			return result;
		},
	};
	const folder = createNativeFolder({
		storage: { ...storage, put: noting.put },
		tables: {},
		directory: root,
	});
	return {
		root,
		storage,
		git: history,
		sync: history.sync,
		/** Every path a Sync of this history wrote or removed, in order. */
		landed,
		/** Replace the file at `path` with `to`, or remove it for `null`. */
		write: async (path: string, to: FileContent | null) => {
			const saved =
				to === null
					? await folder.files.delete(path)
					: await folder.files.write(path, to);
			return saved.error === null ? Ok(undefined) : Err(saved.error);
		},
		files: { read: (path: string) => storage.read(path) },
		close: async () => {
			await folder.close();
			await history.close();
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
