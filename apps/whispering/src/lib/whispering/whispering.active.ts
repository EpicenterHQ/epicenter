/**
 * Boot-time Whispering client for both platforms (Option A: sync singleton +
 * reload).
 *
 * `toWorkspaceConnection` reads the persisted `auth.state` once at startup
 * (ADR-0088/ADR-0094): signed out selects local storage, while signed in or
 * reauth-required selects the principal's synchronized storage. Construction is
 * synchronous; data still loads async
 * behind `whenReady`. Identity changes are never an in-place swap:
 * `reloadOnPrincipalChange` (same subpath, mounted in the root layout) reloads
 * the page so the next boot re-projects.
 *
 * `openWhisperingBrowser` takes the boot inputs every workspace app passes to
 * its browser opener (`auth`) and wraps the doc with the one action
 * every platform needs (`recordings_export_markdown`, whose logic is identical
 * on both platforms; see `recordings-markdown-export.ts`). The two platform
 * leaves (`whispering.browser.ts`, `whispering.tauri.ts`) supply those inputs
 * plus their default transcription service.
 */

import type { SyncAuthClient } from '@epicenter/auth';
import { toWorkspaceConnection } from '@epicenter/svelte/auth';
import { defineActions, satisfiesWorkspace } from '@epicenter/workspace';
import type { TranscriptionServiceId } from '$lib/services/transcription/providers';
import { defineWhispering } from '$lib/workspace';
import { defineRecordingsMarkdownExport } from './recordings-markdown-export';

export function openWhisperingBrowser({
	auth,
	defaultTranscriptionService,
}: {
	auth: SyncAuthClient;
	defaultTranscriptionService: TranscriptionServiceId;
}) {
	const model = defineWhispering(defaultTranscriptionService);
	const bundle = model.connect(toWorkspaceConnection(auth), (workspace) => ({
		actions: defineActions({
			recordings_export_markdown: defineRecordingsMarkdownExport(
				workspace.tables.recordings,
			),
		}),
	}));

	return satisfiesWorkspace({
		...bundle,
		whenReady: bundle.storage.whenLoaded,
	});
}
