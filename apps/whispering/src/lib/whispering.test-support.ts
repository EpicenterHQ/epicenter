/** Construct the real app over test files and test capabilities. */
import type { Files } from './files/files.js';
import type { TestCapabilities } from './services.test-support.js';

/**
 * Same construction as the app (`app.ts`, `+layout.svelte`, `WhisperingApp`):
 * Whispering's folder over `files`, read once before the pages render, then
 * Whispering and its library over it. The lists are followed as mounted
 * pages follow them.
 */
export async function createTestWhispering({
	services,
	files,
}: {
	services: TestCapabilities;
	files: Files;
}) {
	const { createWhispering } = await import('./whispering.svelte.js');
	const { createLibrary } = await import('./library.svelte.js');
	const { openFolder } = await import('./folder.svelte.js');
	const { follow } = await import('./follow.test-support.svelte.js');
	const folder = openFolder(files);
	// The app's pages render once the folder was read.
	await folder.load();
	const whispering = createWhispering({ folder, ...services });
	const library = createLibrary({ whispering, files: folder });
	const followed = follow(() => [
		library.entries,
		library.repairs,
		library.transcriptions,
		library.transformations,
		library.transformationRepairs,
		library.textRepairs,
		folder.transformation_runs.items(),
		folder.text_runs.items(),
		library.entries.map((note) => library.audioOf(note.id)),
	]);
	return {
		/** The folder the app reads and writes, as `app.ts`'s. */
		folder,
		whispering,
		library,
		close() {
			followed.stop();
			library.dispose();
			whispering.dispose();
		},
	};
}
