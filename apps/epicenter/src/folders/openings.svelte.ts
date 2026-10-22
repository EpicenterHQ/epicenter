/**
 * The directories other apps asked Epicenter to open, and the folders it
 * remembers (ADR-0646).
 *
 * A standalone app's "Open in Epicenter" reaches the shell as
 * `epicenter://open?path=…`. The shell only holds the path and shows this
 * window: nothing reads the directory until the person accepts it here.
 * Accepting asks Rust to validate the directory, open its own bound editor,
 * and remember the path. The launcher never owns a folder or its drafts.
 * Existing editors keep their own input while another window opens.
 *
 * Root children and accepted shortcuts appear in the unified folder list.
 */
import type { commands } from '../ui/bindings.gen';

/**
 * The shell's event when the pending requests changed:
 * `FOLDER_OPENINGS_CHANGED` in `src-tauri/src/folder_opening.rs`, sent to
 * this window alone.
 */
export const FOLDER_OPENINGS_CHANGED = 'epicenter://folder-openings-changed';

/** Native requests remain separate from the derived folder list. */
export type OpeningHost = Pick<
	typeof commands,
	'pendingFolderOpenings' | 'acceptFolderOpening' | 'dismissFolderOpening'
>;

/** The last segment of `path`, which names the folder in the list. */
export function folderName(path: string) {
	return path.split(/[/\\]/).filter(Boolean).at(-1) ?? path;
}

function described(cause: unknown) {
	return cause instanceof Error ? cause.message : String(cause);
}

export function createFolderOpenings({ host }: { host: OpeningHost }) {
	let requests = $state<string[]>([]);
	let failure = $state<string>();
	let notice = $state<string>();
	let accepting = $state<string>();
	/** Reads that resolve out of order keep only the newest. */
	let requestSeq = 0;

	async function refresh() {
		const seq = ++requestSeq;
		try {
			const pending = await host.pendingFolderOpenings();
			if (seq === requestSeq) requests = pending;
		} catch (cause) {
			if (seq === requestSeq)
				failure = `Could not read the requests to open folders. ${described(cause)}`;
		}
	}

	return {
		/** The paths apps asked to open, waiting for the person. */
		get requests() {
			return requests;
		},
		/** Why the last acceptance, dismissal, forgetting, or read failed. */
		get failure() {
			return failure;
		},
		/** What else the person should know about the last acceptance. */
		get notice() {
			return notice;
		},
		/** The path being accepted, while the shell checks it. */
		get accepting() {
			return accepting;
		},
		refresh,

		/** Open `path`, which an app asked for, now that the person accepted it. */
		async accept(path: string) {
			if (accepting !== undefined) return;
			failure = undefined;
			notice = undefined;
			accepting = path;
			try {
				let answer: Awaited<ReturnType<OpeningHost['acceptFolderOpening']>>;
				try {
					answer = await host.acceptFolderOpening(path);
				} catch (cause) {
					answer = { data: null, error: described(cause) };
				}
				await refresh();
				if (answer.error !== null) {
					failure = `${path} did not open. ${answer.error}`;
					return;
				}
				const { rememberProblem } = answer.data;
				if (rememberProblem !== null)
					notice = `Epicenter could not update its remembered folders. ${rememberProblem}`;
			} catch (cause) {
				failure = `Could not show ${folderName(path)}. ${described(cause)}`;
			} finally {
				accepting = undefined;
			}
		},

		/** Let go of the request for `path`; nothing reads it. */
		async dismiss(path: string) {
			failure = undefined;
			try {
				await host.dismissFolderOpening(path);
			} catch (cause) {
				failure = `Could not dismiss the request for ${path}. ${described(cause)}`;
			}
			await refresh();
		},
	};
}
