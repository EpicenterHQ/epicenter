import type { WhisperingApp } from '$lib/whispering/app';
import type { RecordingStore } from '../whispering/app.js';
import type { WhisperingQueryRuntime } from './client';
import { createDownloadQueries } from './download';
import { createTranscriptionQueries } from './transcription';

/**
 * Cross-platform query namespace, bound to one ready app. Built once by
 * the UI session and read from context.
 */
export function createWhisperingQueries(
	app: WhisperingApp,
	store: RecordingStore,
	runtime: WhisperingQueryRuntime,
) {
	return {
		download: createDownloadQueries(store, runtime),
		transcription: createTranscriptionQueries(app, store, runtime),
	};
}

export type WhisperingQueries = ReturnType<typeof createWhisperingQueries>;
