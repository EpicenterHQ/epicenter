import { RecorderError } from '@epicenter/app/recorder';
import { createInferenceCatalog } from '@epicenter/app-shell/inference-picker';
import type { Account } from '@epicenter/auth';
import { toHostedCatalog } from '@epicenter/constants/ai-providers';
import { createLogger } from 'wellcrafted/logger';
import { pushToTalk } from '../operations/push-to-talk';
import {
	createWhisperingRecording,
	disposeVadRecording,
} from '../operations/recording.svelte.js';
import { createWhisperingQueryRuntime } from '../queries/client';
import { type WhisperingApp, type WhisperingAppHandle } from './app';
import { importLegacyInferenceSelections } from './inference.js';
import { local } from './local.js';

/** Own recording admission and shell queries for this document. */
export function createWhisperingUiSession({
	openedApp,
	account,
}: {
	openedApp: WhisperingAppHandle;
	account: Account | undefined;
}) {
	importLegacyInferenceSelections(local.kv, account);
	const catalog = createInferenceCatalog({
		ai: openedApp.inference,
		signal: openedApp.signal,
		hostedModels: toHostedCatalog(['gpt-5.4-mini', 'gpt-5.5']),
	});
	const log = createLogger('whispering/ui-session');
	// One flag fences new work and records UI disposal, including late callbacks.
	let recordingEnabled = true;
	const app: WhisperingApp = {
		...openedApp,
		get recordingEnabled() {
			return recordingEnabled && !openedApp.signal.aborted;
		},
		authAccount: account,
		catalog,
		get recording() {
			return recordingSession.recording;
		},
	};
	const recordingSession = createWhisperingRecording(app, openedApp.recorder);
	const queryRuntime = createWhisperingQueryRuntime();

	return {
		app,
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
