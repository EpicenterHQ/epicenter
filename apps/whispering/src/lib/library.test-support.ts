/**
 * A library over a test workspace, built as a session builds it: the
 * folder's local context (`@epicenter/svelte/folder`), then the
 * library over it. Both are runes modules, loaded here once the test has
 * registered the Svelte compiler plugin.
 */
import type { Library } from './library.svelte.js';
import { filesLine } from './status.js';
import type { Workspace } from './workspace/types.js';

/** The header's status line for `library`, as AppHeader words it. */
export const headerLine = (library: Library) =>
	filesLine({
		saving: library.saving,
		unsaved: library.unsaved,
		storageFailure: library.storageFailure,
		unwrittenAnswers: library.unwrittenAnswers,
	});

/** A library over `workspace`, not yet started. */
export async function createTestLibrary(
	workspace: Workspace,
): Promise<Library> {
	const [{ createFolderContext }, { createLibrary }] = await Promise.all([
		import('@epicenter/svelte/folder'),
		import('./library.svelte.js'),
	]);
	return createLibrary(workspace, createFolderContext(workspace.folder));
}

/** A library over `workspace`, started: the folder read once. */
export async function openTestLibrary(workspace: Workspace): Promise<Library> {
	const library = await createTestLibrary(workspace);
	await library.start();
	return library;
}
