import type { HoneycrispData } from '@epicenter/honeycrisp';
import { createFolders } from './folders.svelte.js';
import { createNotes } from './notes.svelte.js';
import { createView } from './view.svelte.js';

export function createHoneycrispState({
	honeycrisp,
	reportBackgroundError,
}: {
	honeycrisp: HoneycrispData;
	reportBackgroundError(cause: unknown): void;
}) {
	let notes!: ReturnType<typeof createNotes>;
	const folders = createFolders({
		honeycrisp,
		refreshNotes: () => notes.refresh(),
	});
	notes = createNotes({ folders, honeycrisp });
	const view = createView({ folders, notes });

	const refresh = () => Promise.all([folders.refresh(), notes.refresh()]);
	const stopFolders = honeycrisp.folders.subscribe(() => {
		void folders.refresh().catch(reportBackgroundError);
	});
	const stopNotes = honeycrisp.notes.subscribe(() => {
		void notes.refresh().catch(reportBackgroundError);
	});
	const whenReady = refresh();

	return {
		folders,
		notes,
		view,
		whenReady,
		[Symbol.dispose]() {
			stopFolders();
			stopNotes();
			view[Symbol.dispose]();
		},
	};
}
