/** Construct the real app over test files and test capabilities. */
import { openFolder } from '@epicenter/folder';
import type { Place } from '@epicenter/folder/core';
import { whispering as contract } from './contract.js';
import type { TestCapabilities } from './services.test-support.js';

/**
 * Same construction as the app's root (`WhisperingApp`): Whispering and its
 * library over a folder opened at `place`, read through `reactive` as
 * `app.ts` reads its folder. The lists are followed as mounted pages follow them, so
 * they list and hear changes.
 */
export async function createTestWhispering({
	services,
	place,
}: {
	services: TestCapabilities;
	place: Place;
}) {
	const { createWhispering } = await import('./whispering.svelte.js');
	const { createLibrary } = await import('./library.svelte.js');
	const { filesOf } = await import('./files.svelte.js');
	const { follow } = await import(
		'../../../../packages/svelte/src/reactive.test-support.svelte.js'
	);
	const { reactive } = await import('@epicenter/svelte/reactive');
	const opened = openFolder(contract, place);
	// The app's pages render once the folder connected (`<WhenOpen>`).
	await opened.recordings.list();
	const folder = reactive(opened);
	const whispering = createWhispering({ folder, ...services });
	const files = filesOf(folder);
	const library = createLibrary({ whispering, files });
	const followed = follow(() => [
		library.entries,
		library.repairs,
		library.transcriptions,
		library.transformations,
		library.transformationRepairs,
		library.textRepairs,
		files.transformation_runs.items(),
		files.text_runs.items(),
		library.entries.map((note) => library.audioOf(note.id)),
	]);
	return {
		/** The folder the app reads and writes, as `app.ts`'s: its state, and a note's editor. */
		folder,
		whispering,
		library,
		close() {
			followed.stop();
			library.dispose();
			whispering.dispose();
			opened[Symbol.dispose]();
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
