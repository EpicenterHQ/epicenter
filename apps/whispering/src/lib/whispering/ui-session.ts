import type { Account } from '@epicenter/auth';
import { defineErrors, type InferErrors } from 'wellcrafted/error';
import { pushToTalk } from '../operations/push-to-talk';
import { createWhisperingRecording } from '../operations/recording.svelte.js';
import { createWhisperingQueries } from '../queries';
import { createWhisperingQueryRuntime } from '../queries/client';
import { createRecordings } from '../state/recordings.svelte';
import { createSettingsView } from '../state/settings.svelte';
import {
	createWhisperingDomains,
	type WhisperingApp,
	type WhisperingAppHandle,
} from './app';

/** Build UI domains, queries, and the recording workflow over one ready App. */
export function createWhisperingUiSession({
	openedApp,
	account,
}: {
	openedApp: WhisperingAppHandle;
	account: Account | null;
}) {
	const domains = createWhisperingDomains({ openedApp, account });
	// Named members rather than a spread of `domains`, which used to carry
	// `[Symbol.dispose]` into the object handed to every component through
	// context. Disposal is off `WhisperingApp` entirely now, and `domains` is the
	// only thing holding it; writing the members out is what keeps a new one
	// from arriving here unwrapped.
	let disposal: Promise<void> | undefined;
	let recordingEnabled = true;
	const app: WhisperingApp = {
		get recordingEnabled() {
			return recordingEnabled;
		},
		account,
		settings: createSettingsView(domains.settings),
		recordings: createRecordings(domains),
		recipes: domains.recipes,
		blobs: domains.blobs,
		get recording() {
			return recordingSession.recording;
		},
		syncStatus: domains.syncStatus,
	};
	const recordingSession = createWhisperingRecording(app, openedApp.recording);
	const queryRuntime = createWhisperingQueryRuntime();
	const queries = createWhisperingQueries(app, queryRuntime);

	return {
		app,
		queries,
		queryClient: queryRuntime.queryClient,
		[Symbol.asyncDispose]() {
			recordingEnabled = false;
			disposal ??= (async () => {
				try {
					await pushToTalk.dispose(app);
				} finally {
					recordingSession[Symbol.dispose]();
					queryRuntime.queryClient.clear();
					domains[Symbol.dispose]();
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
