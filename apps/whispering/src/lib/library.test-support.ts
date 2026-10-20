/**
 * A library over a test workspace, built as the product root builds it: the
 * folder's local context (`@epicenter/svelte/folder`), then the
 * library over it. Both are runes modules, loaded here once the test has
 * registered the Svelte compiler plugin.
 */
import type { Library } from './library.svelte.js';
import { filesLine } from './status.js';
import type { WhisperingFolder, Workspace } from './workspace/types.js';

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
	{ workspace, folder }: { workspace: Workspace; folder: WhisperingFolder },
): Promise<Library> {
	const [{ createFolderContext }, { createLibrary }] = await Promise.all([
		import('@epicenter/svelte/folder'),
		import('./library.svelte.js'),
	]);
	return createLibrary(workspace, createFolderContext(folder));
}

/** A library over `workspace`, started: the folder read once. */
export async function openTestLibrary(
	test: { workspace: Workspace; folder: WhisperingFolder },
): Promise<Library> {
	const library = await createTestLibrary(test);
	await library.start();
	return library;
}

/** Root teardown: register product work before the folder owner closes. */
export async function closeTestLibrary(library: Library) {
	if (library.local.closing) return library.local.close();
	const stopping = library.local.run(() => library.stop());
	const unsaved = await library.local.close();
	await stopping;
	return unsaved;
}

/** Construct product state as FolderApp's child does, after the close guard. */
export async function createTestWhispering(
	{ workspace, folder }: { workspace: Workspace; folder: WhisperingFolder },
) {
	const [{ createFolderContext }, { createWhispering }] = await Promise.all([
		import('@epicenter/svelte/folder'),
		import('./whispering.svelte.js'),
	]);
	const context = createFolderContext(folder);
	try {
		await context.guardWindowClose();
	} catch (cause) {
		await context.close();
		throw cause;
	}
	return createWhispering(context, workspace);
}
export async function openTestWhispering(
	test: { workspace: Workspace; folder: WhisperingFolder },
) {
	const whispering = await createTestWhispering(test);
	await whispering.start();
	return whispering;
}
export async function closeTestWhispering(
	whispering: import('./whispering.svelte.js').Whispering,
) {
	const stopping = whispering.stop();
	const unsaved = await whispering.library.local.close();
	await stopping;
	return unsaved;
}
