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
import { type FolderSchema, openAtRoot } from './open-at-root.js';
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
 * `user.email` the author, with `author` for whichever is missing.
 *
 * No handle waits for another across processes (ADR-0541). A save is checked
 * where it lands: the desktop shell checks each rename against what the page
 * expects, and in Bun the check runs just before the rename, under `locks`
 * so saves within one process take turns. A commit moves the branch only by
 * compare-and-swap, and Git's own lock files keep its index whole. Each
 * handle orders its own Git work. `BroadcastChannel` hints between pages of
 * one origin are best effort.
 */
export async function openDirectoryFolder<
	const TDefinition extends FolderDefinition,
	TDeclared extends FolderDefinition = TDefinition,
>({
	definition,
	lens,
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
	/** With `'declared'`, the prepared shape the folder must contain (ADR-0538). */
	readonly lens?: FolderDefinition;
	/**
	 * Why the first commit of a `'declared'` folder with no repository must
	 * not create one here.
	 */
	readonly initProblem?: () => Promise<string | undefined>;
	/** The directory, as a handle over the host's file system. */
	readonly root: OpfsDirectoryHandle;
	/** The directory's absolute path, for showing to a person and naming hints. */
	readonly rootPath: string;
	/** The system `git` in `rootPath`, and the host's file system. */
	readonly git: NativeGitHost;
	/**
	 * Saves to the directory take turns under these, for a host that checks
	 * and renames in this process (Bun). Without them saves do not wait: the
	 * desktop shell checks each one where it lands.
	 */
	readonly locks?: OpfsLocks;
	readonly BroadcastChannel?: typeof globalThis.BroadcastChannel;
	/** Who commits, where Git's configuration does not say. */
	readonly author: Author;
	readonly branch?: string;
	/** Asked before each push and fetch; see `GitCredentials`. */
	readonly credentials?: GitCredentials;
}): Promise<Result<Folder<TDefinition, TDeclared>, OpenFolderError>> {
	let schema: FolderSchema = 'declared';
	if (definition !== 'declared') {
		const { data: prepared, error: definitionError } =
			prepareFolderDefinition(definition);
		if (definitionError !== null)
			return OpenFolderError.InvalidDefinition(definitionError);
		schema = prepared;
	}
	let shape: FolderDefinition | undefined;
	if (lens !== undefined) {
		const { data: prepared, error: lensError } = prepareFolderDefinition(lens);
		if (lensError !== null) return OpenFolderError.InvalidDefinition(lensError);
		shape = prepared;
	}
	ensureBufferGlobal();
	const configured = async (key: string) => {
		const { code, stdout } = await host.run(['config', '--get', key], {
			allowFailure: true,
		});
		const value = new TextDecoder().decode(stdout).trim();
		return code === 0 && value !== '' ? value : undefined;
	};
	// The name comes from the directory alone, so every opener in this
	// origin hears the others, whatever ID it opened the folder by.
	const address = JSON.stringify(['directory', rootPath]);
	const at = { hintChannel: `epicenter-folder-directory-hints:${address}` };
	// A write that stopped before its rename (a crash, a quit) leaves its
	// staged bytes behind. Another handle or process may be writing the
	// directory now, so only files staged long enough ago to be abandoned are
	// removed. What cannot be removed stays; it is inert.
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
	return openAtRoot<TDefinition, TDeclared>(
		schema,
		{ BroadcastChannel: hintChannel },
		{
			at,
			lens: shape,
			location: { kind: 'directory', root: rootPath },
			async start({ relay, landed }) {
				const boundary =
					locks === undefined
						? createOpfsFileBoundary({ root, landed: relay })
						: createOpfsFileBoundary({
								root,
								locks,
								filesLock: `epicenter-folder-directory-files:${address}`,
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
				// Two handles that open a new folder at once may both run
				// `git init`; the backend runs it again when the race fails it.
				// Each handle orders its own index and branch work; other
				// handles and processes meet Git's own lock files and the
				// branch's compare-and-swap.
				const backend = await createNativeGitBackend({
					root: rootPath,
					branch,
					boundary,
					host,
					credentials,
					initialize: definition === 'declared' ? 'commit' : 'open',
					initialized: readIdentity,
					initProblem,
				});
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
