/**
 * A library over test platform services, built as the product root builds it: the
 * folder's local context (`@epicenter/svelte/folder`), then the
 * library over it. Both are runes modules, loaded here once the test has
 * registered the Svelte compiler plugin.
 */
import { provideServices } from './services.test-support.js';
import type { Library } from './library.svelte.js';
import { filesLine } from './status.js';
import type { WhisperingFolder } from './folder.js';
import type { WhisperingServices } from './platform/types.js';

/** The header's status line for `library`, as AppHeader words it. */
export const headerLine = (library: Library) =>
	filesLine({
		saving: library.saving,
		unsaved: library.unsaved,
		storageFailure: library.storageFailure,
		unwrittenAnswers: library.unwrittenAnswers,
	});

/** A library over `services`, not yet started. */
export async function createTestLibrary(
	{ services, folder }: { services: WhisperingServices; folder: WhisperingFolder },
): Promise<Library> {
	const [{ createFolderContext }, { createLibrary }] = await Promise.all([
		import('@epicenter/svelte/folder'),
		import('./library.svelte.js'),
	]);
	return createLibrary(services, createFolderContext(folder));
}

/** A library over `services`, started: the folder read once. */
export async function openTestLibrary(
	test: { services: WhisperingServices; folder: WhisperingFolder },
): Promise<Library> {
	const library = await createTestLibrary(test);
	await library.start();
	return library;
}

/** Root teardown, as the components run it: the library stops, then the folder closes. */
export function closeTestLibrary(library: Library) {
	library.stop();
	return library.local.close();
}

/** Construct product state as FolderApp's child does, after the close guard. */
export async function createTestWhispering(
	{ services, folder }: { services: WhisperingServices; folder: WhisperingFolder },
) {
	provideServices(folder, services);
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
	return createWhispering(context);
}
export async function openTestWhispering(
	test: { services: WhisperingServices; folder: WhisperingFolder },
) {
	const whispering = await createTestWhispering(test);
	await whispering.start();
	return whispering;
}
export function closeTestWhispering(
	whispering: import('./whispering.svelte.js').Whispering,
) {
	return closeTestLibrary(whispering.library);
}
