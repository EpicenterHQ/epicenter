/** Construct the real app over test files and platform capabilities. */
import type { Client } from '@epicenter/definition/contract';
import type { Whispering as WhisperingContract } from './contract.js';
import type { WhisperingServices } from './platform/types.js';
import { provideServices } from './services.test-support.js';
import { headerStatus } from './status.js';
import type { Whispering } from './whispering.svelte.js';

/** The header's status line, as AppHeader words it. */
export const headerLine = (whispering: Whispering) =>
	headerStatus({
		unwrittenAnswers: whispering.unwrittenAnswers,
		signedIn: whispering.signedIn,
		waiting: whispering.waiting,
		repositoryProblem: whispering.files.repositoryError?.message,
	});

/**
 * Same construction as WhisperingApp's, over this browser's files and,
 * signed in, the repository. The lists are followed as a mounted app's
 * views follow them, so they list and hear changes.
 */
export async function createTestWhispering({
	services,
	device,
	repository = null,
}: {
	services: WhisperingServices;
	device: Client<WhisperingContract>;
	repository?: Client<WhisperingContract> | null;
}) {
	provideServices(services);
	const { createWhispering } = await import('./whispering.svelte.js');
	const { follow } = await import(
		'../../../../packages/svelte/src/reactive.test-support.svelte.js'
	);
	const whispering = createWhispering({ device, repository });
	const followed = follow(() => [
		whispering.entries,
		whispering.repairs,
		whispering.transcriptions,
		whispering.transformations,
		whispering.transformationRepairs,
		whispering.textRepairs,
		whispering.files.transformation_runs.items,
		whispering.files.text_runs.items,
		whispering.entries.map((note) => whispering.audioOf(note.id)),
		whispering.waiting,
	]);
	return {
		whispering,
		close() {
			followed.stop();
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
