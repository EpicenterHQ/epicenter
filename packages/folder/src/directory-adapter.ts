/**
 * A folder in an ordinary directory a trusted host has given this page: the
 * desktop app's directory folder. Files go through the browser folder's file
 * storage over directory primitives (`directory-handle.ts`); history is real
 * Git (`git/native-backend.ts`), which the host runs. Nothing of the browser
 * folder's own address, claim, download, or private Git is here.
 */
import type { Result } from 'wellcrafted/result';
import { ensureBufferGlobal } from './buffer-global.js';
import {
	type FolderDefinition,
	prepareFolderDefinition,
} from './definition.js';
import { SCRATCH_DIRECTORY } from './directory-handle.js';
import { OpenFolderError } from './errors.js';
import type { Folder } from './folder.js';
import { createHistory } from './git/history.js';
import {
	createNativeGitBackend,
	type NativeGitHost,
} from './git/native-backend.js';
import type { Author } from './git/objects.js';
import { webLockExclusive } from './git/web-lock-exclusive.js';
import { type FolderAddress, openAtRoot } from './open-at-root.js';
import {
	createOpfsFileBoundary,
	type OpfsDirectoryHandle,
	type OpfsLocks,
} from './opfs-store.js';

/**
 * Open the folder in an ordinary directory a trusted host has already given
 * this page: the desktop app's shell decides the directory, takes the lock
 * that keeps other processes out of it, and grants the page access to it.
 *
 * The directory is the folder: there is no ready marker and no address to
 * claim, and a repository someone already made there is used as it is.
 * Files are read and written through the browser folder's storage over
 * `root`. History is real Git (`createNativeGitBackend` over `git`), so it
 * honors Git's lock files, packed refs, and configuration, and another Git
 * program can share the repository. Git's own configuration decides the rest:
 * `remote.origin.url` is the remote, on `branch`, and `user.name` and
 * `user.email` the author, with `author` for whichever is missing. Pages of
 * the same origin coordinate through `locks` and `BroadcastChannel`, as
 * browser tabs do.
 */
export async function openDirectoryFolder<
	const TDefinition extends FolderDefinition,
>({
	definition,
	id,
	root,
	rootPath,
	git: host,
	locks,
	BroadcastChannel: hintChannel,
	author,
	branch = 'main',
}: {
	readonly definition: TDefinition;
	readonly id: string;
	/** The directory, as a handle over the host's file system. */
	readonly root: OpfsDirectoryHandle;
	/** The directory's absolute path, for showing to a person and naming locks. */
	readonly rootPath: string;
	/** The system `git` in `rootPath`, and the host's file system. */
	readonly git: NativeGitHost;
	readonly locks: OpfsLocks;
	readonly BroadcastChannel?: typeof globalThis.BroadcastChannel;
	/** Who commits, where Git's configuration does not say. */
	readonly author: Author;
	readonly branch?: string;
}): Promise<Result<Folder<TDefinition>, OpenFolderError>> {
	const { data: prepared, error: definitionError } =
		prepareFolderDefinition(definition);
	if (definitionError !== null)
		return OpenFolderError.InvalidDefinition(definitionError);
	if (typeof id !== 'string' || id.trim() === '')
		return OpenFolderError.InvalidId({ id: String(id) });
	ensureBufferGlobal();
	const configured = async (key: string) => {
		const { code, stdout } = await host.run(['config', '--get', key], {
			allowFailure: true,
		});
		const value = new TextDecoder().decode(stdout).trim();
		return code === 0 && value !== '' ? value : undefined;
	};
	let committer: Author;
	try {
		// Read before Git work is set up; a folder with no repository yet has
		// none of these, and `git init` follows.
		const isRepository =
			(await host.files.lstat(`${rootPath}/.git/HEAD`)) !== undefined;
		committer = {
			name:
				(isRepository ? await configured('user.name') : undefined) ??
				author.name,
			email:
				(isRepository ? await configured('user.email') : undefined) ??
				author.email,
		};
	} catch (cause) {
		return OpenFolderError.Unavailable({ cause });
	}
	const address = JSON.stringify(['directory', rootPath, id]);
	const at: FolderAddress = {
		address,
		directory: rootPath,
		openLock: `epicenter-folder-directory-open:${address}`,
		filesLock: `epicenter-folder-directory-files:${address}`,
		gitLock: `epicenter-folder-directory-git:${address}`,
		hintChannel: `epicenter-folder-directory-hints:${address}`,
	};
	// A write that stopped before its rename (a crash, a quit) leaves its
	// staged bytes behind. Every write stages under the files lock, so none is
	// in flight while it is held. What cannot be removed stays; it is inert.
	const scratch = `${rootPath}/${SCRATCH_DIRECTORY}`;
	try {
		await locks.request(at.filesLock, {}, async () => {
			if ((await host.files.lstat(scratch))?.kind !== 'directory') return;
			for (const entry of await host.files.readDir(scratch))
				if (entry.kind === 'file')
					await host.files.remove(`${scratch}/${entry.name}`).catch(() => {});
		});
	} catch {
		// Leftovers are inert; an open that cannot clear them still opens.
	}
	return openAtRoot<TDefinition>(
		prepared,
		{ BroadcastChannel: hintChannel },
		{
			at,
			location: { kind: 'directory', root: rootPath },
			async start({ relay, landed }) {
				const boundary = createOpfsFileBoundary({
					root,
					locks,
					filesLock: at.filesLock,
					landed: relay,
				});
				// Creating the repository runs under the open lock: two windows
				// that open a new folder at once would both run `git init`.
				// Afterward every window of the app orders the folder's index
				// and branch work through one Web Lock; other processes meet
				// Git's own lock files.
				const backend = await locks.request(at.openLock, {}, () =>
					createNativeGitBackend({
						root: rootPath,
						branch,
						boundary,
						host,
						exclusive: webLockExclusive(locks, at.gitLock),
					}),
				);
				const history = createHistory({
					backend,
					boundary,
					author: committer,
					definition: prepared,
					landed,
				});
				return { boundary, history };
			},
		},
	);
}
