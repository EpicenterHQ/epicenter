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
import { isStaleScratch, SCRATCH_DIRECTORY } from './directory-handle.js';
import { OpenFolderError } from './errors.js';
import type { Folder } from './folder.js';
import { createHistory } from './git/history.js';
import type { GitCredentials } from './git/http.js';
import {
	createNativeGitBackend,
	type NativeGitHost,
} from './git/native-backend.js';
import type { Author } from './git/objects.js';
import { webLockExclusive } from './git/web-lock-exclusive.js';
import {
	type FolderAddress,
	type FolderSchema,
	openAtRoot,
} from './open-at-root.js';
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
 * With a `definition`, a directory with no repository gets one when opened,
 * and the handle publishes the definition to `epicenter.json`. With
 * `'declared'`, the handle reads with the folder's own `epicenter.json` and
 * never writes it, and opening creates nothing: the first commit, staging,
 * or remote creates the repository.
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
	initProblem,
	root,
	rootPath,
	git: host,
	locks,
	BroadcastChannel: hintChannel,
	author,
	branch = 'main',
	credentials,
}: {
	/** The opener's definition, or `'declared'` for the folder's own. */
	readonly definition: TDefinition | 'declared';
	/**
	 * Why the first commit of a `'declared'` folder with no repository must
	 * not create one here.
	 */
	readonly initProblem?: () => Promise<string | undefined>;
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
	/** Asked before each push and fetch; see `GitCredentials`. */
	readonly credentials?: GitCredentials;
}): Promise<Result<Folder<TDefinition>, OpenFolderError>> {
	let schema: FolderSchema = 'declared';
	if (definition !== 'declared') {
		const { data: prepared, error: definitionError } =
			prepareFolderDefinition(definition);
		if (definitionError !== null)
			return OpenFolderError.InvalidDefinition(definitionError);
		schema = prepared;
	}
	ensureBufferGlobal();
	const configured = async (key: string) => {
		const { code, stdout } = await host.run(['config', '--get', key], {
			allowFailure: true,
		});
		const value = new TextDecoder().decode(stdout).trim();
		return code === 0 && value !== '' ? value : undefined;
	};
	// The names come from the directory alone, so every opener in this
	// process or origin coordinates, whatever ID it opened the folder by.
	const address = JSON.stringify(['directory', rootPath]);
	const at: FolderAddress = {
		address,
		directory: rootPath,
		openLock: `epicenter-folder-directory-open:${address}`,
		filesLock: `epicenter-folder-directory-files:${address}`,
		gitLock: `epicenter-folder-directory-git:${address}`,
		hintChannel: `epicenter-folder-directory-hints:${address}`,
	};
	// A write that stopped before its rename (a crash, a quit) leaves its
	// staged bytes behind. The files lock orders only this process's or this
	// origin's writes, and another process may be writing the directory, so
	// only files staged long enough ago to be abandoned are removed. What
	// cannot be removed stays; it is inert.
	const scratch = `${rootPath}/${SCRATCH_DIRECTORY}`;
	try {
		if ((await host.files.lstat(scratch))?.kind === 'directory') {
			const now = Date.now();
			for (const entry of await host.files.readDir(scratch))
				if (entry.kind === 'file' && isStaleScratch(entry.name, now))
					await host.files.remove(`${scratch}/${entry.name}`).catch(() => {});
		}
	} catch {
		// Leftovers are inert; an open that cannot clear them still opens.
	}
	return openAtRoot<TDefinition>(
		schema,
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
				// The person's own Git identity, read once the repository exists:
				// the desktop shell answers `config --get` only inside one.
				let identity = author;
				const readIdentity = async () => {
					identity = {
						name: (await configured('user.name')) ?? author.name,
						email: (await configured('user.email')) ?? author.email,
					};
				};
				// Creating the repository on open runs under the open lock: two
				// windows that open a new folder at once would both run
				// `git init`. A deferred one runs inside the Git lock, with the
				// first commit. Every window of the app orders the folder's
				// index and branch work through that one Web Lock; other
				// processes meet Git's own lock files.
				const backend = await locks.request(at.openLock, {}, () =>
					createNativeGitBackend({
						root: rootPath,
						branch,
						boundary,
						host,
						exclusive: webLockExclusive(locks, at.gitLock),
						credentials,
						initialize: definition === 'declared' ? 'commit' : 'open',
						initialized: readIdentity,
						initProblem,
					}),
				);
				if ((await host.files.lstat(`${rootPath}/.git/HEAD`)) !== undefined)
					await readIdentity();
				return {
					boundary,
					history: (prepared) =>
						createHistory({
							backend,
							boundary,
							// Read at each commit, so a repository the first commit
							// creates commits as the person's identity too.
							author: {
								get name() {
									return identity.name;
								},
								get email() {
									return identity.email;
								},
							},
							definition: prepared,
							landed,
						}),
				};
			},
		},
	);
}
