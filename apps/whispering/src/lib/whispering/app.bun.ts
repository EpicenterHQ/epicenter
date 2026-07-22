import {
	type BlobByteSource,
	type BunBlobRead,
	openBunRecordEpicenter,
} from '@epicenter/data/bun';
import { consoleSink, type LogEvent } from 'wellcrafted/logger';
import { requireFinalizedAudioBytes } from '../services/recorder/contract';
import type { TranscriptionServiceId } from '../services/transcription/providers';
import type { WhisperingAppDependencies } from './app';

export type CreateWhisperingBunDependenciesOptions = {
	/**
	 * The one caller-owned root for all persistent Whispering storage. Every
	 * child path derives from it: the replica owns `<dataDir>/epicenter.sqlite3`
	 * and content-addressed audio files below `<dataDir>/blobs/`.
	 */
	dataDir: string;
	defaultTranscriptionService?: TranscriptionServiceId;
};

/**
 * Native dependencies for scripts and long-lived local agent hosts.
 * Construction is inert; the record replica opens only when the caller awaits
 * `openWhisperingApp`. Blob publication is part of record sync, not a second
 * application-owned remote storage capability.
 */
export function createWhisperingBunDependencies({
	dataDir,
	defaultTranscriptionService = 'local',
}: CreateWhisperingBunDependenciesOptions): WhisperingAppDependencies<
	BlobByteSource,
	BunBlobRead
> {
	return {
		openEpicenter: () => openBunRecordEpicenter({ directory: dataDir }),
		prepareAudio: (audio) => requireFinalizedAudioBytes(audio).stream(),
		materializeAudio: (read) => new Response(read).blob(),
		defaultTranscriptionService,
		reportBackgroundError(cause) {
			consoleSink({
				ts: Date.now(),
				level: 'error',
				source: 'whispering/app',
				message: 'Whispering app background failure',
				data: cause,
			} satisfies LogEvent);
		},
	};
}
