/**
 * The desktop's one detector of changes a page did not make (ADR-0548): the
 * shell watches each granted directory and announces what changed as the
 * folder plugin's `epicenter-folder://changed` event, sent to each window
 * the folder is permitted to. Tauri also delivers an event sent to one
 * window to every page's global `listen`, so the page listens on its own
 * window, and reports only its own folder's scope.
 */
import type { UnlistenFn } from '@tauri-apps/api/event';
import { createLogger } from 'wellcrafted/logger';
import type { FilesChanged } from './folder.js';
import type { ChangeDetector } from './open-at-root.js';

const log = createLogger('folder/changes-tauri');

/** The event the folder plugin emits when the shell's watcher sees changes. */
export const FOLDER_CHANGED_EVENT = 'epicenter-folder://changed';

/**
 * What the shell reports: the folder's scope, and the paths that changed,
 * relative to its root with `/`, or `null` when it cannot say which (it
 * started watching, the computer woke, or the operating system dropped
 * events). The single path `.git` is history moving (`HEAD` or a ref).
 */
export type FolderChangedPayload = {
	readonly scope: string;
	readonly paths: string[] | null;
};

export function tauriChangeDetector(scope: string): ChangeDetector {
	return (report: (change: FilesChanged) => void) => {
		let open = true;
		let unlisten: UnlistenFn | undefined;
		// Loaded when a folder is granted, like the rest of the desktop engine.
		import('@tauri-apps/api/webviewWindow')
			.then(({ getCurrentWebviewWindow }) =>
				getCurrentWebviewWindow().listen<FolderChangedPayload>(
					FOLDER_CHANGED_EVENT,
					({ payload }) => {
						if (!open || payload?.scope !== scope) return;
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
						new Error(`Could not hear changes to the folder '${scope}'.`, {
							cause,
						}),
					),
			);
		return {
			stop() {
				open = false;
				unlisten?.();
			},
		};
	};
}
