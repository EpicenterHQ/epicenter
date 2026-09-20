import { RecorderError } from '@epicenter/app/recorder';
import { createInferenceCatalog } from '@epicenter/app-shell/inference-picker';
import { toHostedCatalog } from '@epicenter/constants/ai-providers';
import type { Account } from '@epicenter/auth';
import { fromData, fromKv } from '@epicenter/svelte';
import { createLogger } from 'wellcrafted/logger';
import { pushToTalk } from '../operations/push-to-talk';
import {
	createWhisperingRecording,
	disposeVadRecording,
} from '../operations/recording.svelte.js';
import { createWhisperingQueries } from '../queries';
import { createWhisperingQueryRuntime } from '../queries/client';
import { importLegacyInferenceSelections } from './inference.js';
import {
	type WhisperingApp,
	type WhisperingAppHandle,
	type WhisperingData,
} from './app';

/** Adapt the selected library and device settings, then own recording and query lifetimes. */
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
		openedApp.device.kv,
		openedApp.account?.identity,
	);
	const library = fromData(data);
	const catalog = createInferenceCatalog({
		ai: {
			runtime: openedApp.device.connections.runtime,
			connections: openedApp.device.connections.custom,
			account: openedApp.account?.connection ?? null,
		},
		hostedModels: toHostedCatalog(['gpt-5.4-mini', 'gpt-5.5']),
	});
	const log = createLogger('whispering/ui-session');
	// One flag fences new work and records UI disposal, including late callbacks.
	let recordingEnabled = true;
	const app: WhisperingApp = {
		signal: openedApp.signal,
		get recordingEnabled() {
			return recordingEnabled;
		},
		account,
		device: { kv: fromKv(openedApp.device.kv) },
		library,
		catalog,
		blobs: openedApp.blobs,
		get recording() {
			return recordingSession.recording;
		},
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
		},
	};
}
