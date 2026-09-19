import type { InferenceSelections } from '@epicenter/app-shell/inference-selections';
import { RecorderError } from '@epicenter/app/recorder';
import { createLogger } from 'wellcrafted/logger';
import type { Account } from '@epicenter/auth';
import { pushToTalk } from '../operations/push-to-talk';
import {
	disposeVadRecording,
	createWhisperingRecording,
} from '../operations/recording.svelte.js';
import { createWhisperingQueries } from '../queries';
import { createWhisperingQueryRuntime } from '../queries/client';
import { createWhisperingConnections } from '../state/inference-connections.svelte.js';
import { createRecordings } from '../state/recordings.svelte';
import { createSettingsView } from '../state/settings.svelte';
import {
	createWhisperingDomains,
	type WhisperingApp,
	type WhisperingAppHandle,
	type WhisperingData,
} from './app';

/** Build UI domains, queries, and the recording workflow over one ready App. */
export function createWhisperingUiSession({
	openedApp,
	data,
	account,
	selections,
}: {
	openedApp: WhisperingAppHandle;
	data: WhisperingData;
	selections: InferenceSelections;
	account: Account | undefined;
}) {
	const domains = createWhisperingDomains({ openedApp, data });
	const inference = createWhisperingConnections(openedApp, selections);
	// Named members rather than a spread of `domains`, which used to carry
	// `[Symbol.dispose]` into the object handed to every component through
	// context. Disposal is off `WhisperingApp` entirely now, and `domains` is the
	// only thing holding it; writing the members out is what keeps a new one
	// from arriving here unwrapped.
	const log = createLogger('whispering/ui-session');
	// One flag fences new work and records UI disposal, including late callbacks.
	let recordingEnabled = true;
	const app: WhisperingApp = {
		signal: openedApp.signal,
		get recordingEnabled() {
			return recordingEnabled;
		},
		account,
		settings: createSettingsView(domains.settings),
		inferenceConnections: inference,
		recordings: createRecordings(domains),
		recipes: domains.recipes,
		blobs: openedApp.blobs,
		get recording() {
			return recordingSession.recording;
		},
		syncStatus: domains.syncStatus,
	};
	const recordingSession = createWhisperingRecording(
		app,
		openedApp.device.recording,
	);
	const queryRuntime = createWhisperingQueryRuntime();
	const queries = createWhisperingQueries(app, queryRuntime);

	return {
		app,
		queries,
		queryClient: queryRuntime.queryClient,
		[Symbol.dispose]() {
			if (!recordingEnabled) return;
			recordingEnabled = false;
			pushToTalk.dispose(app);
			recordingSession[Symbol.dispose]();
			void disposeVadRecording().catch((cause) =>
				log.warn(RecorderError.RecorderFailed({ cause })),
			);
			queryRuntime.queryClient.clear();
			domains[Symbol.dispose]();
		},
	};
}

export type WhisperingUiSession = ReturnType<typeof createWhisperingUiSession>;
