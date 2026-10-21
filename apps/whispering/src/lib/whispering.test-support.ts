/** Construct the real app over a test FolderContext and platform capabilities. */

import type { WhisperingFolder } from './folder.js';
import type { WhisperingServices } from './platform/types.js';
import { provideServices } from './services.test-support.js';
import { filesLine } from './status.js';
import type { Whispering } from './whispering.svelte.js';

/** The header's status line, as AppHeader words it. */
export const headerLine = (whispering: Whispering) =>
	filesLine({
		saving: whispering.saving,
		unsaved: whispering.unsaved,
		storageFailure: whispering.storageFailure,
		unwrittenAnswers: whispering.unwrittenAnswers,
	});

/** Same construction as FolderApp's child, retaining context beside the app for tests. */
export async function createTestWhispering({
	services,
	folder,
}: {
	services: WhisperingServices;
	folder: WhisperingFolder;
}) {
	provideServices(folder, services);
	const [{ createFolderContext }, { createWhispering }] = await Promise.all([
		import('@epicenter/svelte/folder'),
		import('./whispering.svelte.js'),
	]);
	const context = createFolderContext(folder);
	return { whispering: createWhispering(context), context };
}
export async function openTestWhispering(test: {
	services: WhisperingServices;
	folder: WhisperingFolder;
}) {
	const opened = await createTestWhispering(test);
	await opened.whispering.start();
	return opened;
}
export function closeTestWhispering({
	whispering,
	context,
}: Awaited<ReturnType<typeof createTestWhispering>>) {
	whispering.dispose();
	return context.close();
}
