import { invoke, isTauri } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';
import { createLogger } from 'wellcrafted/logger';

const log = createLogger('application-close');

/** A desktop document acknowledges closure only after its owner finishes. */
export async function attachDesktopClose(close: () => Promise<void>) {
	if (!isTauri()) return () => {};
	return listen<{ requestId: string }>(
		'epicenter:close-application',
		(event) => {
			void (async () => {
				let error: string | null = null;
				try {
					await close();
				} catch (cause) {
					error =
						cause instanceof Error
							? cause.message
							: 'Application close failed.';
				}
				await invoke('finish_application_close', {
					requestId: event.payload.requestId,
					error,
				});
			})().catch((cause) => {
				// Native times out and refuses replacement if acknowledgement fails.
				log.error(
					new Error('Could not acknowledge application closure.', { cause }),
				);
			});
		},
	);
}
