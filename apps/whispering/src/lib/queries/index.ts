import type { WhisperingApplication as WhisperingApp } from '$lib/whispering/application';
import { createAudioQueries } from './audio';
import type { WhisperingQueryRuntime } from './client';
import { createDownloadQueries } from './download';
import { createTranscriptionQueries } from './transcription';

/**
 * Cross-platform query namespace, bound to one ready application. Built once by
 * the provider and read from context; query operations that do not touch the
 * application (audio availability, download) compose in unchanged.
 */
export function createWhisperingQueries(
	app: WhisperingApp,
	runtime: WhisperingQueryRuntime,
) {
	return {
		audio: createAudioQueries(runtime),
		download: createDownloadQueries(runtime),
		transcription: createTranscriptionQueries(app, runtime),
	};
}

export type WhisperingQueries = ReturnType<typeof createWhisperingQueries>;
