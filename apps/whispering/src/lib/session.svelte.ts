/**
 * One Whispering session: the opened workspace, the product state over it,
 * and what the shell is showing.
 *
 * A session exists only once it has started: the folder was read. Before that
 * there is an opening, not a session.
 *
 * The app layout opens exactly one session when it mounts and closes it when it
 * is destroyed. Pages receive it from context and never open a workspace, so
 * moving between `/`, `/recordings`, and `/transformations` keeps the live
 * recording, selections, running requests, the query cache,
 * and the terminal exactly as they were. Quitting the desktop app is
 * immediate: a recording and a run's result are in the folder from the moment
 * they start (ADR-0542, ADR-0543).
 */
import type { QueryClient } from '@tanstack/svelte-query';
import { createContext } from 'svelte';
import { Err, Ok, type Result } from 'wellcrafted/result';
import { createLibrary } from './library.svelte.js';
import { DEFAULT_SORT, type RecordingSort } from './recording-collection.js';
import { createSettingsDraft } from './settings-draft.svelte.js';
import {
	openWorkspace,
	type Workspace,
	type WorkspaceError,
} from './workspace/index.js';

/** Why an opening ended with no session although nothing failed. */
const RELEASED = 'The layout was released before its session finished opening.';

const messageOf = (cause: unknown) =>
	cause instanceof Error ? cause.message : String(cause);

/**
 * Close what a failed opening opened, then reject with why it failed. When
 * closing fails too, the rejection says so, with the opening's failure as its
 * cause. The message is shown to the person, so it does not repeat the
 * closing failure's details.
 */
async function failOpening(
	startup: unknown,
	close: () => Promise<void>,
): Promise<never> {
	try {
		await close();
	} catch {
		throw new Error(
			`${messageOf(startup)} Whispering could not confirm that the folder was released afterward.`,
			{ cause: startup },
		);
	}
	throw startup;
}

/**
 * Build the session over an opened workspace: read the folder once.
 *
 * A session that cannot start is not returned. Its library and workspace are
 * closed first, which waits for whatever they had under way, and only then
 * does this reject with why it failed. The same happens when `released` is
 * aborted before the start settles: nothing is left open.
 */
export async function createSession(
	workspace: Workspace,
	queryClient: QueryClient,
	released?: AbortSignal,
) {
	const library = createLibrary(workspace, queryClient);
	try {
		await library.start();
		if (released?.aborted) throw new Error(RELEASED);
	} catch (cause) {
		return failOpening(cause, () => library.close());
	}
	/** What the shell shows. Held here so no route owns it. */
	const view = $state({
		sidebarOpen: false,
		/** The file browser beside the page, on a wide window. */
		filesPane: false,
		/** The file browser in a sheet, on a narrow window. */
		filesSheet: false,
		terminalOpen: false,
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
		 * Text pasted to try a transformation on. One text for the session, so
		 * it stays when the person moves between pages or transformations. It
		 * is never written anywhere; a run takes a copy of it when it starts.
		 */
		pastedText: '',
		/**
		 * The transformation chosen for post-processing, by row path. Undefined
		 * is None, which is how a session starts. Choosing sends nothing: a
		 * transformation runs only when the person asks for it.
		 */
		postProcessing: undefined as string | undefined,
	});
	const settings = createSettingsDraft(library);
	// A ticked recording whose file a listing no longer finds is unticked then,
	// not later: a file made afterward at the same path is another recording
	// and must not arrive ticked. A search hides rows without removing them,
	// and a listing that failed is not heard here, so neither unticks anything.
	// The library drops this listener when it closes.
	library.onRecordingsListed((present) => {
		if (view.recordingSelected.some((path) => !present.has(path)))
			view.recordingSelected = view.recordingSelected.filter((path) =>
				present.has(path),
			);
	});
	let closing: Promise<void> | undefined;

	return {
		workspace,
		library,
		view,
		/** The one draft of the connection settings, wherever its form is shown. */
		settings,
		/**
		 * Whether a navigation must be held back. A navigation between this app's
		 * routes unloads nothing and is never held. One that unloads the document
		 * is held while an edit is not in its file yet; in a browser tab that
		 * raises the browser's own leave warning.
		 */
		blocksNavigation(navigation: { readonly willUnload: boolean }): boolean {
			return navigation.willUnload && library.unsaved;
		},
		/** Wait for what is being written, and release the folder. Runs once. */
		close(): Promise<void> {
			closing ??= library.close();
			return closing;
		},
	};
}

export type Session = Awaited<ReturnType<typeof createSession>>;

/**
 * Open the workspace this page was given and start a session over it, with
 * `queryClient` holding what it reads and running what it writes. Called
 * by the app layout when it mounts; importing this module opens nothing. A
 * workspace that cannot be opened is returned as the reason, and no session
 * exists. A session that cannot start, or whose layout was released first,
 * rejects after everything it opened has been closed. A rejection from `open`
 * itself passes through as it is.
 */
export async function openSession(
	queryClient: QueryClient,
	open: () => Promise<Result<Workspace, WorkspaceError>> = openWorkspace,
	released?: AbortSignal,
): Promise<Result<Session, WorkspaceError>> {
	const { data: workspace, error: openError } = await open();
	if (openError !== null) return Err(openError);
	if (released?.aborted)
		return failOpening(new Error(RELEASED), () => workspace.close());
	return Ok(await createSession(workspace, queryClient, released));
}

/**
 * What the app layout holds from mount to destroy: one opening, and the
 * release of whatever it became. Released before the opening settles, the
 * opening closes what it opened by itself.
 */
export function mountSession(
	queryClient: QueryClient,
	open: () => Promise<Result<Workspace, WorkspaceError>> = openWorkspace,
) {
	const releasing = new AbortController();
	const opening = openSession(queryClient, open, releasing.signal);
	return {
		opening,
		release() {
			if (releasing.signal.aborted) return;
			releasing.abort();
			void opening
				.then(({ data: session, error }) =>
					error === null ? session.close() : undefined,
				)
				.catch(() => {});
		},
	};
}

/** The session of the mounted app layout. Set by the shell, read by pages. */
export const [getSession, setSession] = createContext<Session>();
