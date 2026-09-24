import { tauri } from '#platform/tauri';
import { outputWritesToCursor } from '$lib/operations/delivery';
import { report } from '$lib/report';
import type { WhisperingApp } from '$lib/whispering/app';

/**
 * Tell Rust whether delivery writes at the cursor. Cursor delivery uses a
 * synthetic Cmd/Ctrl+V; on macOS the supervisor holds a passive tap to verify
 * that Accessibility can deliver it and surface the notice when the grant is
 * missing or stale. `outputWritesToCursor` is the single source of truth shared
 * with `delivery.ts`; reading it inside the `$effect` keeps the push live as the
 * output toggles change. Desktop only: the browser build registers nothing.
 */
export function synchronizeAutoPasteIntent(app: WhisperingApp): void {
	if (!tauri) return;
	const t = tauri;

	$effect(() => {
		void t.keyboard
			.setAutoPasteEnabled(outputWritesToCursor())
			.catch((cause) => {
				report.error({
					title: 'Failed to update paste-at-cursor intent',
					cause,
				});
			});
	});
}
