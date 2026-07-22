import type { WhisperingApp } from '$lib/whispering/app';
import { createAudioQueries } from './audio';
import type { WhisperingQueryRuntime } from './client';
import { createDownloadQueries } from './download';
import { createTranscriptionQueries } from './transcription';

/**
 * Cross-platform query namespace, bound to one ready app. Built once by
 * the UI session and read from context.
 */
export function createWhisperingQueries(
	app: WhisperingApp,
	runtime: WhisperingQueryRuntime,
) {
	return {
		audio: createAudioQueries(app, runtime),
		download: createDownloadQueries(app, runtime),
		transcription: createTranscriptionQueries(app, runtime),
	};
}

export type WhisperingQueries = ReturnType<typeof createWhisperingQueries>;
