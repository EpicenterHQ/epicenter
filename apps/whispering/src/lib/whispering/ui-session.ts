import { RecorderError } from '@epicenter/app/recorder';
import { createInferenceCatalog } from '@epicenter/app-shell/inference-picker';
import type { Account } from '@epicenter/auth';
import { toHostedCatalog } from '@epicenter/constants/ai-providers';
import { fromData } from '@epicenter/svelte';
import { createLogger } from 'wellcrafted/logger';
import { pushToTalk } from '../operations/push-to-talk';
import {
	createWhisperingRecording,
	disposeVadRecording,
} from '../operations/recording.svelte.js';
import { createWhisperingQueries } from '../queries';
import { createWhisperingQueryRuntime } from '../queries/client';
import {
	type WhisperingApp,
	type WhisperingAppHandle,
	type WhisperingData,
} from './app';
import { importLegacyInferenceSelections } from './inference.js';

/** Adapt both App stores and own the recording and query lifetimes. */
export function createWhisperingUiSession({
	openedApp,
	data,
	account,
}: {
	openedApp: WhisperingAppHandle;
	data: WhisperingData;
	account: Account | undefined;
}) {
	importLegacyInferenceSelections(
		openedApp.local.kv,
		openedApp.epicenterInference?.identity,
	);
	const library = fromData(data);
	const catalog = createInferenceCatalog({
		ai: {
			runtime: openedApp.runtimeInference,
			connections: openedApp.connections,
			account: openedApp.epicenterInference ?? null,
		},
		hostedModels: toHostedCatalog(['gpt-5.4-mini', 'gpt-5.5']),
	});
	const log = createLogger('whispering/ui-session');
	// One flag fences new work and records UI disposal, including late callbacks.
	let recordingEnabled = true;
	const app: WhisperingApp = {
		...openedApp,
		local: fromData(openedApp.local),
		personal: openedApp.personal ? fromData(openedApp.personal) : undefined,
		get recordingEnabled() {
			return recordingEnabled;
		},
		authAccount: account,
		library,
		catalog,
		get recording() {
			return recordingSession.recording;
		},
	};
	const recordingSession = createWhisperingRecording(app, openedApp.recorder);
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
		},
	};
}
