/** Construct the real app over test files and test capabilities. */
import type { Files } from './files/files.js';
import { openPage, type TestCapabilities } from './services.test-support.js';

/**
 * Same construction as the app (`app.ts`, `+layout.svelte`, `WhisperingApp`):
 * Whispering's folder and the page's query client over `files`, read once
 * before the pages render, then Whispering and its library over it. The
 * lists are followed as mounted pages follow them.
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
	const { follow, rooted } = await import('./follow.test-support.svelte.js');
	// The app's pages render once the folder was read.
	const page = await openPage(files);
	// Each is made inside an effect root, as a component's script makes it.
	const madeWhispering = rooted(() =>
		createWhispering({ query: page.query, ...services }),
	);
	const whispering = madeWhispering.value;
	const made = rooted(() => createLibrary({ whispering, query: page.query }));
	const library = made.value;
	const followed = follow(() => [
		library.entries,
		library.repairs,
		library.transcriptions,
		library.entries.map((note) => library.audioOf(note.id)),
		library.entries.map((note) => library.transcribing(note.id)),
	]);
	return {
		/** The folder the app reads and writes, as `app.ts`'s. */
		folder: page.folder,
		/** The page's query client over it, as `app.ts`'s. */
		query: page.query,
		whispering,
		library,
		close() {
			followed.stop();
			library.dispose();
			made.stop();
			whispering.dispose();
			madeWhispering.stop();
			page.close();
		},
	};
}
