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
import {
	FOLDER_CHANGED_EVENT,
	type FolderChanged,
} from './native/bindings.gen.js';
import type { ChangeDetector } from './open-at-root.js';

const log = createLogger('folder/changes-tauri');

export function tauriChangeDetector(scope: string): ChangeDetector {
	return (report: (change: FilesChanged) => void) => {
		let open = true;
		let unlisten: UnlistenFn | undefined;
		// Loaded when a folder is granted, like the rest of the desktop engine.
		const ready = import('@tauri-apps/api/webviewWindow')
			.then(({ getCurrentWebviewWindow }) =>
				getCurrentWebviewWindow().listen<FolderChanged>(
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
			ready: ready.then(() => {}),
			stop() {
				open = false;
				unlisten?.();
			},
		};
	};
}
