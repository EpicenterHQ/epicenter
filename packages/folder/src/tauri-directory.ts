/**
 * A desktop folder the page opens with its own engine: the shell granted
 * this window the folder's directory (`grant_directory`) and holds its lock.
 * The page reads and changes files through the shell, which checks every
 * path, and records history with the system `git`, which the shell runs for
 * it (`run_git`). Real Git does the transfers too,
 * with the person's own credentials.
 *
 * Loaded only once a folder is granted, so importing the desktop opener
 * carries none of this.
 */
import type { Result } from 'wellcrafted/result';
import type { FolderDefinition } from './definition.js';
import { openDirectoryFolder } from './directory-adapter.js';
import { directoryHandle } from './directory-handle.js';
import { tauriDirectoryPrimitives } from './directory-tauri.js';
import type { OpenFolderError } from './errors.js';
import type { Folder } from './folder.js';
import type { GitCredentials } from './git/http.js';
import type { Granted } from './native/bindings.gen.js';
import { tauriGitRun } from './tauri-git.js';

export async function openGrantedFolder<
	const TDefinition extends FolderDefinition,
>({
	definition,
	id,
	granted,
	credentials,
}: {
	/** The page's definition, or `'declared'` for the folder's own. */
	readonly definition: TDefinition | 'declared';
	readonly id: string;
	readonly granted: Granted;
	readonly credentials?: GitCredentials;
}): Promise<Result<Folder<TDefinition>, OpenFolderError>> {
	const files = tauriDirectoryPrimitives(id);
	return openDirectoryFolder({
		definition,
		root: directoryHandle(files, granted.root),
		rootPath: granted.root,
		git: { run: tauriGitRun(id), files },
		BroadcastChannel: globalThis.BroadcastChannel,
		author: { name: granted.authorName, email: granted.authorEmail },
		branch: granted.branch,
		credentials,
		// The shell's answer at the grant: a data folder inside another
		// repository's working tree. `run_git` refuses that `git init` too.
		initProblem: async () => granted.initProblem ?? undefined,
	});
}
