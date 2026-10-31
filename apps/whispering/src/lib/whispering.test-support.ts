/** Construct the real app over test files and platform capabilities. */
import type { Client } from '@epicenter/definition/contract';
import type { Whispering as WhisperingContract } from './contract.js';
import type { Library } from './library.svelte.js';
import type { WhisperingServices } from './platform/types.js';
import { provideServices } from './services.test-support.js';
import { headerStatus } from './status.js';

/** The header's status line over `library`, as AppHeader words it. */
export const headerLine = (library: Library, signedIn = false) =>
	headerStatus({
		view: library.view,
		unwrittenAnswers: library.unwrittenAnswers,
		auth: signedIn ? 'signed-in' : 'signed-out',
		problem: library.error?.message,
	});

/**
 * Same construction as the app's: what both views share
 * (`WhisperingApp`), "On this device" over `device`, and, signed in, "Synced"
 * over `repository` (`WhisperingView`). Each view's lists are followed as
 * its mounted pages follow them, so they list and hear changes.
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
	const { createLibrary } = await import('./library.svelte.js');
	const { deviceFiles, syncedFiles } = await import('./files.svelte.js');
	const { follow } = await import(
		'../../../../packages/svelte/src/reactive.test-support.svelte.js'
	);
	const whispering = createWhispering({ device });
	const libraries: Library[] = [];
	function view(files: Parameters<typeof createLibrary>[0]['files']) {
		const library = createLibrary({ whispering, files });
		libraries.push(library);
		return library;
	}
	const onDevice = view(deviceFiles(device));
	const synced =
		repository === null ? null : view(syncedFiles(repository, device));
	const followed = libraries.map((library) =>
		follow(() => [
			library.entries,
			library.repairs,
			library.transcriptions,
			library.transformations,
			library.transformationRepairs,
			library.textRepairs,
			library.files.transformation_runs.items,
			library.files.text_runs.items,
			library.entries.map((note) => library.audioOf(note.id)),
		]),
	);
	return {
		whispering,
		/** "On this device". */
		onDevice,
		/** "Synced", when a repository was given. */
		synced,
		close() {
			for (const following of followed) following.stop();
			for (const library of libraries) library.dispose();
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
