/**
 * The desktop's one detector of changes a page did not make (ADR-0548): the
 * shell watches each opened directory and announces what changed as the
 * folder plugin's `epicenter-folder://changed` event, sent to each window
 * bound to that directory. A window has one folder, so the event names none.
 * Tauri also delivers an event sent to one window to every page's global
 * `listen`, so the page listens on its own window alone.
 */
import type { UnlistenFn } from '@tauri-apps/api/event';
import { createLogger } from 'wellcrafted/logger';
import {
	FOLDER_CHANGED_EVENT,
	type FolderChanged,
} from './native/bindings.gen.js';

const log = createLogger('folder/changes-tauri');

/** Which files changed: their paths, or `'everything'` when the shell cannot say. */
export type FilesChanged = readonly string[] | 'everything';

/**
 * Listen for the shell's reports about this window's folder, calling
 * `report` for each. `ready` settles once the page hears changes; `stop`
 * ends listening.
 */
export function tauriChangeDetector() {
	return (report: (change: FilesChanged) => void) => {
		let open = true;
		let unlisten: UnlistenFn | undefined;
		// Loaded when a folder is granted, like the rest of the desktop engine.
		const ready = import('@tauri-apps/api/webviewWindow')
			.then(({ getCurrentWebviewWindow }) =>
				getCurrentWebviewWindow().listen<FolderChanged>(
					FOLDER_CHANGED_EVENT,
					({ payload }) => {
						if (!open || !payload) return;
						report(payload.paths === null ? 'everything' : payload.paths);
					},
				),
			)
			.then(
				(stop) => {
					if (open) unlisten = stop;
					else stop();
				},
				(cause: unknown) =>
					log.error(
						new Error("Could not hear changes to this window's folder.", {
							cause,
						}),
					),
			);
		return {
			ready: ready.then(() => {}),
			stop() {
				open = false;
				unlisten?.();
			},
		};
	};
}
