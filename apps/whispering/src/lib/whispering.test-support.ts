/** Construct the real app over a test folder and platform capabilities. */

import type { WhisperingFolder } from './folder.js';
import type { WhisperingServices } from './platform/types.js';
import { provideServices } from './services.test-support.js';
import { filesLine } from './status.js';
import type { Whispering } from './whispering.svelte.js';

/** The header's status line, as AppHeader words it. */
export const headerLine = (whispering: Whispering) =>
	filesLine({
		saving: whispering.saving,
		unwrittenAnswers: whispering.unwrittenAnswers,
	});

/** Same construction as WhisperingApp's, over the folder `<OpenFolder>` would hand it. */
export async function createTestWhispering({
	services,
	folder,
}: {
	services: WhisperingServices;
	folder: WhisperingFolder;
}) {
	provideServices(folder, services);
	const { createWhispering } = await import('./whispering.svelte.js');
	return { whispering: createWhispering(folder), folder };
}
export async function openTestWhispering(test: {
	services: WhisperingServices;
	folder: WhisperingFolder;
}) {
	const opened = await createTestWhispering(test);
	await opened.whispering.start();
	return opened;
}
/** Stop the app; the test's `remove` closes its folder. */
export function closeTestWhispering({
	whispering,
}: Awaited<ReturnType<typeof createTestWhispering>>) {
	whispering.dispose();
}
