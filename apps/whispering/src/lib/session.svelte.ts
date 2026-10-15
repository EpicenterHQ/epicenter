/**
 * One Whispering session: the opened workspace, the product state over it, the
 * close guard, and what the shell is showing.
 *
 * A session exists only once it has started: the folder was read and the
 * close guard is listening. Before that there is an opening, not a session,
 * and nothing answers the shell for it.
 *
 * The app layout opens exactly one session when it mounts and closes it when it
 * is destroyed. Pages receive it from context and never open a workspace, so
 * moving between `/`, `/recordings`, and `/transformations` keeps the live
 * recording, selections, running requests, the query cache,
 * and the terminal exactly as they were. Only leaving the app is guarded.
 */
import type { QueryClient } from '@tanstack/svelte-query';
import { createContext } from 'svelte';
import { Err, Ok, type Result } from 'wellcrafted/result';
import { createLeaveGuard } from './leave.svelte.js';
import { createLibrary } from './library.svelte.js';
import { DEFAULT_SORT, type RecordingSort } from './recording-collection.js';
import { createSettingsDraft } from './settings-draft.svelte.js';
import {
	answerCloseAfterFailedOpening,
	openWorkspace,
	quitAfterFailedOpening,
	type Workspace,
	type WorkspaceError,
} from './workspace/index.js';

/** Why an opening ended with no session although nothing failed. */
const RELEASED = 'The layout was released before its session finished opening.';

const messageOf = (cause: unknown) =>
	cause instanceof Error ? cause.message : String(cause);

/**
 * An opening that failed after everything it had opened was closed. This is
 * the only rejection that proves nothing is held, so it is the only one after
 * which a close is answered without looking.
 *
 * `startup` is why the opening failed, and the message is its message.
 */
export class OpeningReleasedError extends Error {
	override readonly name = 'OpeningReleasedError';
	constructor(readonly startup: unknown) {
		super(messageOf(startup), { cause: startup });
	}
}

/**
 * An opening that failed, and whose closing of what it had opened failed too.
 * Nothing confirms that the folder was released or that work under way has
 * ended, so nothing may answer the shell's close for this opening.
 *
 * `startup` is why the opening failed; `cleanup` is why closing failed. The
 * message is shown to the person, so it carries the startup message, which is
 * shown for any failed opening, and says only that releasing failed.
 */
export class OpeningNotReleasedError extends Error {
	override readonly name = 'OpeningNotReleasedError';
	constructor(
		readonly startup: unknown,
		readonly cleanup: unknown,
	) {
		super(
			`${messageOf(startup)} Whispering could not confirm that the folder was released afterward, so this window does not approve closing by itself.`,
			{ cause: startup },
		);
	}
}

/**
 * Close what a failed opening opened, then reject with why it failed: as an
 * `OpeningReleasedError` once the close has completed, or as an
 * `OpeningNotReleasedError` with both reasons when it failed.
 */
async function failOpening(
	startup: unknown,
	close: () => Promise<void>,
): Promise<never> {
	try {
		await close();
	} catch (cleanup) {
		throw new OpeningNotReleasedError(startup, cleanup);
	}
	throw new OpeningReleasedError(startup);
}

/**
 * Build the session over an opened workspace: read the folder once, then start
 * answering the shell.
 *
 * The order is the point. The first read is this session's own work in the
 * folder. Until it has settled nothing may tell the shell it can close, so
 * the close guard does
 * not exist until then: a close asked meanwhile is kept by the workspace and
 * handed to the guard the moment it starts listening, and the guard then
 * decides from a session that has finished starting.
 *
 * A session that cannot start is not returned. Its library and workspace are
 * closed first, which waits for whatever they had under way, and only then
 * does this reject, with an `OpeningReleasedError`. The same happens when
 * `released` is aborted before the start settles: nothing listens and nothing
 * is left open. When closing them fails, it rejects with an
 * `OpeningNotReleasedError` instead, since then nothing confirms that they
 * were closed.
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
	const leave = createLeaveGuard(library, workspace.closing);
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
		leave,
		view,
		/** The one draft of the connection settings, wherever its form is shown. */
		settings,
		/**
		 * Whether a navigation must be held back. A navigation between this app's
		 * routes unloads nothing and is never held. One that unloads the document
		 * is held while something exists only in this window; in a browser tab
		 * that raises the browser's own leave warning.
		 */
		blocksNavigation(navigation: { readonly willUnload: boolean }): boolean {
			return navigation.willUnload && library.holdsUnsavedWork;
		},
		/** Stop answering the shell, wait for what is being written, and release the folder. Runs once. */
		close(): Promise<void> {
			closing ??= (async () => {
				leave.dispose();
				await library.close();
			})();
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
 * rejects with an `OpeningReleasedError` after everything it opened has been
 * closed, or with an `OpeningNotReleasedError` when closing it failed. A
 * rejection from `open` itself passes through as it is: it says nothing about
 * what that opener acquired before it threw.
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
 * release of whatever it became.
 *
 * An opening ends one of two ways, and the desktop shell's close question
 * needs an answer in both. When a session exists, its guard answers, and only
 * after looking at what the session holds. When opening failed there is no
 * session and nothing held, and the person must still be able to close the
 * window, so their close requests are answered from then on.
 *
 * While the opening is still under way nothing answers, and that lasts until
 * the session has finished starting: opening the workspace, the first read of
 * the folder, and the read of this device's connections. A request made in
 * that time waits, and is answered by whichever of the two the opening
 * becomes. A refused opening holds nothing. A rejected one is answered for
 * only when it proves that everything it opened was closed
 * (`OpeningReleasedError`). Any other rejection, such as a failed close or an
 * opener that threw partway through acquiring, is never answered for: nothing
 * confirms that nothing is held, so a close asked then stays unanswered.
 *
 * `release` undoes exactly one of them: it closes the session, or stops
 * answering for the failed opening. Released before the opening settles, the
 * opening closes what it opened by itself and nothing ever answers.
 *
 * Whatever the failure, the failed window also offers the person's own quit
 * (`quit`), so a window whose failure proves nothing can still be left. It
 * answers only when pressed, refuses until the opening has failed, and
 * refuses after release. It is undefined where no shell asks a close
 * question.
 */
export function mountSession(
	queryClient: QueryClient,
	open: () => Promise<Result<Workspace, WorkspaceError>> = openWorkspace,
	answerClose: () => () => void = answerCloseAfterFailedOpening,
	quitWhenAsked:
		| (() => Promise<string | undefined>)
		| undefined = quitAfterFailedOpening(),
) {
	const releasing = new AbortController();
	const opening = openSession(queryClient, open, releasing.signal);
	let stopAnswering: (() => void) | undefined;
	/** Whether the opening ended with no session, however it failed. */
	let openingFailed = false;
	const failed = () => {
		if (!releasing.signal.aborted) stopAnswering = answerClose();
	};
	void opening.then(
		({ error }) => {
			if (error === null) return;
			openingFailed = true;
			failed();
		},
		(cause: unknown) => {
			openingFailed = true;
			if (cause instanceof OpeningReleasedError) failed();
		},
	);
	return {
		opening,
		/** The person's own quit after the opening failed. Returns why it did not go through. */
		quit:
			quitWhenAsked &&
			(async (): Promise<string | undefined> => {
				if (!openingFailed || releasing.signal.aborted)
					return 'Whispering is not ready to quit from here.';
				return quitWhenAsked();
			}),
		release() {
			if (releasing.signal.aborted) return;
			releasing.abort();
			stopAnswering?.();
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
