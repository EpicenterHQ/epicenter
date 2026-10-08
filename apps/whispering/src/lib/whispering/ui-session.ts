import { defineErrors, type InferErrors } from 'wellcrafted/error';
import { pushToTalk } from '../operations/push-to-talk';
import { watchManualRecordingEnded } from '../operations/recording';
import { createWhisperingQueries } from '../queries';
import { createWhisperingQueryRuntime } from '../queries/client';
import { createRecordings } from '../state/recordings.svelte';
import { createSettingsView } from '../state/settings.svelte';
import {
	openWhisperingApp,
	type WhisperingApp,
	type WhisperingAppDependencies,
} from './app';
import { createRecordingEditor } from './recording-editor.js';

function createWhisperingUiSession(core: WhisperingApp) {
	const app: WhisperingApp = {
		...core,
		settings: createSettingsView(core.settings),
		recordings: createRecordings(core),
		recipes: core.recipes,
	};
	const queryRuntime = createWhisperingQueryRuntime();
	const queries = createWhisperingQueries(app, queryRuntime);
	// A capture can end without anyone asking, including while no screen is
	// mounted, so the reaction belongs to the session rather than to a component.
	watchManualRecordingEnded(app);
	const recordingEditor = createRecordingEditor(core.recordings);
	let disposal: Promise<void> | undefined;

	return {
		app,
		queries,
		recordingEditor,
		queryClient: queryRuntime.queryClient,
		[Symbol.asyncDispose]() {
			recordingEditor[Symbol.dispose]();
			disposal ??= (async () => {
				try {
					await pushToTalk.dispose(app);
				} finally {
					queryRuntime.queryClient.clear();
					await core[Symbol.asyncDispose]();
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

export async function openWhisperingUiSession(
	dependencies: WhisperingAppDependencies,
	signal: AbortSignal,
): Promise<WhisperingUiSession> {
	const core = await openWhisperingApp(dependencies, { signal });
	try {
		return createWhisperingUiSession(core);
	} catch (cause) {
		await core[Symbol.asyncDispose]();
		throw cause;
	}
}
