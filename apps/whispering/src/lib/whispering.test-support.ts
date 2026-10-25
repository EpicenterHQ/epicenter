/** Construct the real app over a test folder and platform capabilities. */

import type { WhisperingFolder } from './folder.js';
import type { PresentWriteFailure } from './files.js';
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
	presentWriteFailure = () => {},
}: {
	services: WhisperingServices;
	folder: WhisperingFolder;
	presentWriteFailure?: PresentWriteFailure;
}) {
	provideServices(folder, services);
	const { createWhispering } = await import('./whispering.svelte.js');
	return { whispering: createWhispering(folder, presentWriteFailure), folder };
}
export async function openTestWhispering(test: {
	services: WhisperingServices;
	folder: WhisperingFolder;
	presentWriteFailure?: PresentWriteFailure;
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
