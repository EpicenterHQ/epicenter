/** Product state for one mounted Whispering app, beside FolderApp's context. */
import { createContext } from 'svelte';
import { createLogger } from 'wellcrafted/logger';
import type { WhisperingContext } from './folder.js';
import { createLibrary, STOPPED } from './library.svelte.js';
import type { PostProcessingChoice } from './post-processing.js';
import { DEFAULT_SORT, type RecordingSort } from './recording-collection.js';
import { createSettingsDraft } from './settings-draft.svelte.js';
import type { Workspace } from './workspace/index.js';
const log = createLogger('whispering');

/** Construct without reading; start performs recording recovery and product reads. */
export function createWhispering(
	context: WhisperingContext,
	workspace: Workspace,
) {
	const library = createLibrary(workspace, context);
	/** What the shell shows. Held here so no route owns it. */
	const view = $state({
		sidebarOpen: false,
		/** The file browser beside the page, on a wide window. */
		filesPane: false,
		/** The file browser in a sheet, on a narrow window. */
		filesSheet: false,
		/** The recordings search. Rows needing repair are never searched out. */
		recordingQuery: '',
		/** The order of the recordings table. */
		recordingSort: DEFAULT_SORT as RecordingSort,
		/**
		 * The recordings selected in the table, by row path. A successful
		 * listing removes paths that left the folder; search keeps hidden selections.
		 */
		recordingSelected: [] as string[],
		/**
		 * An action on several recordings that is under way: how far it has got.
		 * Held here so a page change neither hides it nor lets a second start.
		 */
		recordingBulk: undefined as
			| {
					readonly label: string;
					readonly done: number;
					readonly total: number;
			  }
			| undefined,
		/**
		 * Whether a recording's details are showing: beside the table on a wide
		 * window, in place of it on a narrow one. Closing them changes nothing
		 * else: the recording stays selected.
		 */
		showingDetail: false,
		/** On a narrow window, whether a transformation's editor shows in place of the list. */
		showingTransformation: false,
		/** The transcription a transformation is tried on, by row path. */
		applyTo: undefined as string | undefined,
		/** What a transformation's page runs on: a saved transcript, or pasted text. */
		applySource: 'transcript' as 'transcript' | 'pasted',
		/**
		 * Text pasted to try a transformation on. One text for the mounted app, so
		 * it stays when the person moves between pages or transformations. It
		 * is never written anywhere; a run takes a copy of it when it starts.
		 */
		pastedText: '',
		/**
		 * The transformation chosen for post-processing, by row path. Undefined
		 * is None, which is how the app starts. Choosing sends nothing: a
		 * transformation runs only when the person asks for it.
		 */
		postProcessing: undefined as string | undefined,
	});
	const settings = createSettingsDraft(library);
	// The product state owns these explicit forms. Closing never presses Save or Run
	// for a person; accepted connection saves run through the local context.
	const unregisterSettings = context.registerUnsent(() =>
		settings.transcription.unsent || settings.text.unsent
			? 'A connection setting has not been saved. Save or clear it before closing.'
			: undefined,
	);
	const unregisterPasted = context.registerUnsent(() =>
		view.pastedText !== ''
			? 'Pasted text has not been run or cleared. Copy or clear it before closing.'
			: undefined,
	);
	const unlist = library.onRecordingsListed((present) => {
		if (view.recordingSelected.some((path) => !present.has(path)))
			view.recordingSelected = view.recordingSelected.filter((path) =>
				present.has(path),
			);
	});
	let starting: Promise<void> | undefined;
	let stopping: Promise<void> | undefined;
	return {
		library,
		view,
		settings,
		/**
		 * The post-processing choice read against the transformations as last
		 * listed and the library's one recipe resolver. The folder is the truth
		 * about the chosen transformation: it may have been deleted, or edited
		 * into something that cannot run, since it was chosen. Nothing here runs it.
		 */
		get postProcessing(): PostProcessingChoice {
			const path = view.postProcessing;
			if (path === undefined) return { kind: 'none' };
			const entry = library.transformations.find((item) => item.path === path);
			if (entry === undefined) return { kind: 'missing', path };
			const resolved = library.resolve(entry.row);
			return resolved.kind === 'ready'
				? { kind: 'ready', entry }
				: { kind: 'repair', entry, reason: resolved.reason };
		},
		/**
		 * Whether a navigation must be held back. A navigation between this app's
		 * routes unloads nothing and is never held. One that unloads the document
		 * is held while typing is not in its file yet, or a save or action runs;
		 * in a browser tab that raises the browser's own leave warning.
		 */
		blocksNavigation(navigation: { readonly willUnload: boolean }): boolean {
			return navigation.willUnload && (library.busy || context.leaving);
		},
		/** Start product work. A failed start stops the library and preserves its cause. */
		start(): Promise<void> {
			return (starting ??= (async () => {
				try {
					await library.start();
					if (library.closing) throw new Error(STOPPED);
				} catch (cause) {
					try {
						await library.stop();
					} catch (stopCause) {
						log.error(
							new Error('Whispering did not stop after startup failed', {
								cause: stopCause,
							}),
						);
					}
					throw cause;
				}
			})());
		},
		/**
		 * Register teardown synchronously. Root close waits for the recorder's
		 * final writes, accepted actions, and recording
		 * recovery through context.run, never for startup display reads.
		 */
		stop(): Promise<void> {
			return (stopping ??= (() => {
				unregisterSettings();
				unregisterPasted();
				unlist();
				const stopped = library.stop();
				return context.run(() => stopped);
			})());
		},
	};
}
export type Whispering = ReturnType<typeof createWhispering>;
export const [getWhispering, setWhispering] = createContext<Whispering>();
