import { join } from 'node:path';
import { createBunBlobStore } from '@epicenter/blobs/bun';
import { openBunEpicenter } from '@epicenter/data/runtime/bun';
import { consoleSink, type LogEvent } from 'wellcrafted/logger';
import type { TranscriptionServiceId } from '../services/transcription/providers';
import type { WhisperingAppDependencies } from './app';

export type CreateWhisperingBunDependenciesOptions = {
	/**
	 * The one caller-owned root for all persistent Whispering storage. Every
	 * child path derives from it: Data owns `<dataDir>/epicenter.sqlite3` and
	 * audio bytes live under `<dataDir>/blobs/`.
	 */
	dataDir: string;
	defaultTranscriptionService?: TranscriptionServiceId;
};

/**
 * Native dependencies for scripts and long-lived local agent hosts.
 * Construction is inert; SQLite opens and directories appear only when the
 * caller awaits `openWhisperingApp`. There is no remote blob capability: a
 * standalone Bun host has no signed-in deployment, so remote audio workflows
 * honestly refuse instead of pretending.
 */
export function createWhisperingBunDependencies({
	dataDir,
	defaultTranscriptionService = 'local',
}: CreateWhisperingBunDependenciesOptions): WhisperingAppDependencies {
	return {
		openEpicenter: () => openBunEpicenter({ directory: dataDir, owner: null }),
		blobs: {
			local: createBunBlobStore({ directory: join(dataDir, 'blobs') }),
			remote: null,
		},
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
