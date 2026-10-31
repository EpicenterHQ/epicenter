/**
 * What the desktop page says once its shell answered "Sync with Epicenter"
 * (`syncWithEpicenter` from `@epicenter/folder/tauri`). The shell's answer
 * means only that the system took the `epicenter://init` link: Epicenter
 * asks the person where to sync before it sets anything up, so the page
 * never says the folder syncs.
 */
import type { SyncRequest } from './desktop-context.js';

/** What the page can say once the shell answered a sync request (`error`: its refusal, if any). */
export function syncRequestOutcome(error: unknown): SyncRequest {
	if (error === null || error === undefined)
		return {
			tone: 'requested',
			message:
				'Asked your computer to open Epicenter. If it is installed, choose where to sync there.',
		};
	return {
		tone: 'failed',
		message:
			`Could not ask your computer to open Epicenter. ${describe(error)}`.trim(),
	};
}

/** A refusal's words: the shell's `message` or `reason`, else the value itself. */
function describe(error: unknown) {
	if (typeof error === 'object' && error !== null) {
		if ('message' in error && typeof error.message === 'string')
			return error.message;
		if ('reason' in error && typeof error.reason === 'string')
			return error.reason;
	}
	return String(error);
}
