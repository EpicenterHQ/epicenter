/**
 * `@epicenter/app/files/native`: open an ordinary directory as a folder.
 *
 * The root is explicit. Its files are the live source, edited concurrently by
 * people, agents, and Git. Checks against the observed version are best
 * effort: another program can race them. Multi-file operations are ordered
 * steps that report partial progress rather than transactions.
 */
import type { DataDefinition } from '../data/definition/declaration.js';
import {
	assembleFolder,
	compileFolderDefinition,
	type Folder,
	type FolderGitOptions,
} from './folder.js';
import { createHistory } from './git/history.js';
import { createNativeGitBackend } from './git/native-backend.js';
import { createNativeFileBoundary, resolveNativeRoot } from './native-store.js';

export { GitCommandError } from './git/native-backend.js';

export type NativeFolderOptions<TDefinition extends DataDefinition> = {
	/** The folder's directory. A Git repository is initialized there if absent. */
	readonly root: string;
	readonly definition: TDefinition;
	readonly git: FolderGitOptions;
};

export async function openNativeFolder<
	const TDefinition extends DataDefinition,
>({
	root,
	definition,
	git,
}: NativeFolderOptions<TDefinition>): Promise<Folder<TDefinition>> {
	compileFolderDefinition(definition);
	const resolved = await resolveNativeRoot(root);
	const boundary = createNativeFileBoundary(resolved);
	const backend = await createNativeGitBackend({
		root: resolved,
		branch: git.remote?.branch ?? 'main',
		remote: git.remote,
		boundary,
	});
	const history = createHistory({
		backend,
		boundary,
		author: git.author,
		commitOnEdit: git.commitOnEdit ?? true,
	});
	return assembleFolder({
		definition,
		boundary,
		history,
		release: async () => {},
	});
}
