/** Construct the real app over test files and test capabilities. */
import type { Client } from '@epicenter/definition/contract';
import { createFolder } from '@epicenter/folder/core';
import { Ok } from 'wellcrafted/result';
import {
	type Whispering as WhisperingContract,
	whispering as contract,
} from './contract.js';
import type { Library } from './library.svelte.js';
import type { TestCapabilities } from './services.test-support.js';
import { headerStatus, ON_THIS_BROWSER } from './status.js';

/** The header's status line over `library`, as the web app's Chrome words it. */
export const headerLine = (library: Library) =>
	headerStatus({ unwrittenAnswers: library.unwrittenAnswers }, ON_THIS_BROWSER);

/**
 * Same construction as the app's root (`WhisperingApp`): Whispering and its
 * library over a folder of `client`, read through `reactive` as `app.ts`
 * reads its folder. The lists are followed as mounted pages follow them, so
 * they list and hear changes.
 */
export async function createTestWhispering({
	services,
	client,
}: {
	services: TestCapabilities;
	client: Client<WhisperingContract>;
}) {
	const { createWhispering } = await import('./whispering.svelte.js');
	const { createLibrary } = await import('./library.svelte.js');
	const { filesOf } = await import('./files.svelte.js');
	const { follow } = await import(
		'../../../../packages/svelte/src/reactive.test-support.svelte.js'
	);
	const { reactive } = await import('@epicenter/svelte/reactive');
	const folder = reactive(createFolder(contract, async () => Ok(client)));
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
