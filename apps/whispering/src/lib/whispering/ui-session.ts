import type { Account } from '@epicenter/auth';
import { defineErrors, type InferErrors } from 'wellcrafted/error';
import { pushToTalk } from '../operations/push-to-talk';
import { watchManualRecordingEnded } from '../operations/recording';
import { createWhisperingQueries } from '../queries';
import { createWhisperingQueryRuntime } from '../queries/client';
import { createRecordings } from '../state/recordings.svelte';
import { createSettingsView } from '../state/settings.svelte';
import {
	createWhisperingApp,
	type WhisperingAccountData,
	type WhisperingApp,
	type WhisperingBlobs,
} from './app';

/**
 * Everything that lives for as long as the app UI is mounted, over a store that
 * already lives longer.
 *
 * **Two lifetimes, and this is the shorter one.** The replica is the document's
 * (ADR-0088): it is opened once by the `(app)` layout and ended by the
 * document being replaced when identity changes. A query client, a settings
 * view, a recordings projection, the manual-recording watcher, and the
 * push-to-talk registration are the UI's, so they are built when the boot
 * reaches `ready` and released when that subtree goes.
 *
 * It is synchronous, and that is the whole shape change. It used to be
 * `openWhisperingUiSession(dependencies, signal)`: an `await` over an opener
 * that acquired a store, wrapped in an `AbortSignal` because a route could
 * unmount mid-acquisition, rendered through an `{#await}`, and disposed by a
 * helper that existed to arbitrate the resolve-after-unmount race. Nothing here
 * acquires now, so there is no in-flight anything to abort and no race to
 * arbitrate.
 */
export function createWhisperingUiSession({
	data,
	blobs,
	account,
}: {
	data: WhisperingAccountData;
	blobs: WhisperingBlobs;
	account: Account;
}) {
	const core = createWhisperingApp({ data, blobs, account });
	// Named members rather than a spread of `core`, which used to carry
	// `[Symbol.dispose]` into the object handed to every component through
	// context. Disposal is off `WhisperingApp` entirely now, and `core` is the
	// only thing holding it; writing the members out is what keeps a new one
	// from arriving here unwrapped.
	const app: WhisperingApp = {
		account,
		settings: createSettingsView(core.settings),
		recordings: createRecordings(core),
		recipes: core.recipes,
		blobs: core.blobs,
		syncStatus: core.syncStatus,
	};
	const queryRuntime = createWhisperingQueryRuntime();
	const queries = createWhisperingQueries(app, queryRuntime);
	// A capture can end without anyone asking, including while no screen is
	// mounted, so the reaction belongs to the session rather than to a component.
	watchManualRecordingEnded(app);
	let disposal: Promise<void> | undefined;

	return {
		app,
		queries,
		queryClient: queryRuntime.queryClient,
		[Symbol.asyncDispose]() {
			disposal ??= (async () => {
				try {
					await pushToTalk.dispose(app);
				} finally {
					queryRuntime.queryClient.clear();
					core[Symbol.dispose]();
				}
			})();
			return disposal;
		},
	};
}

export type WhisperingUiSession = ReturnType<typeof createWhisperingUiSession>;

export const WhisperingUiSessionError = defineErrors({
	TeardownFailed: ({ cause }: { cause: unknown }) => ({
		message: 'Whispering UI session teardown failed',
		cause,
	}),
});
export type WhisperingUiSessionError = InferErrors<
	typeof WhisperingUiSessionError
>;
