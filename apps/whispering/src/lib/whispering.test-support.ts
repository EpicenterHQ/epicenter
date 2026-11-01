/** Construct the real app over test files and platform capabilities. */
import type { Client } from '@epicenter/definition/contract';
import type { Whispering as WhisperingContract } from './contract.js';
import type { Library } from './library.svelte.js';
import type { WhisperingServices } from './platform/types.js';
import { provideServices } from './services.test-support.js';
import { headerStatus, ON_THIS_BROWSER } from './status.js';

/** The header's status line over `library`, as the web app's Chrome words it. */
export const headerLine = (library: Library) =>
	headerStatus({ unwrittenAnswers: library.unwrittenAnswers }, ON_THIS_BROWSER);

/**
 * Same construction as the app's root (`WhisperingApp`): Whispering and its
 * library over `client`. The lists are followed as mounted pages follow
 * them, so they list and hear changes.
 */
export async function createTestWhispering({
	services,
	client,
}: {
	services: WhisperingServices;
	client: Client<WhisperingContract>;
}) {
	provideServices(services);
	const { createWhispering } = await import('./whispering.svelte.js');
	const { createLibrary } = await import('./library.svelte.js');
	const { filesOf } = await import('./files.svelte.js');
	const { follow } = await import(
		'../../../../packages/svelte/src/reactive.test-support.svelte.js'
	);
	const whispering = createWhispering({ client });
	const { fromClient } = await import('@epicenter/svelte/client');
	const library = createLibrary({
		whispering,
		files: filesOf(client, fromClient(client)),
	});
	const followed = follow(() => [
		library.entries,
		library.repairs,
		library.transcriptions,
		library.transformations,
		library.transformationRepairs,
		library.textRepairs,
		library.files.transformation_runs.items,
		library.files.text_runs.items,
		library.entries.map((note) => library.audioOf(note.id)),
	]);
	return {
		whispering,
		library,
		close() {
			followed.stop();
			library.dispose();
			whispering.dispose();
		},
	};
}

/** `createTestWhispering`, started as the app root starts it. */
export async function openTestWhispering(
	test: Parameters<typeof createTestWhispering>[0],
) {
	const opened = await createTestWhispering(test);
	await opened.whispering.start();
	return opened;
}
