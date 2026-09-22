import {
	openEpicenterInference,
	openRuntimeTranscriber,
} from '@epicenter/app/ai';
import {
	openAccountConnectionCatalog,
	openLocalConnectionCatalog,
} from '@epicenter/app/ai-connections';
import { openPersonal } from '@epicenter/app/open';
import { createRecorder } from '@epicenter/app/recorder';
import type { Account } from '@epicenter/auth';
import { extractErrorMessage } from 'wellcrafted/error';
import { createLogger } from 'wellcrafted/logger';
import { whisperingDefinition } from '../data.js';
import { local, openLocalStore } from './local.js';
import { createPendingSaves } from './pending-saves.js';
import type { PersonalStore } from './personal.js';
import { preparePlaybackWorker } from './playback-worker.js';

const log = createLogger('whispering/resources');

/** Root handles belong to this browser/WebView. The signal fences workflow work. */
export async function openWhisperingResources(
	account: Account | undefined,
	signal: AbortSignal,
) {
	signal.throwIfAborted();
	await openLocalStore();
	signal.throwIfAborted();
	const personalReady: Promise<PersonalStore | undefined> = account
		? openPersonal(whisperingDefinition, { account }).then((store) => {
				signal.throwIfAborted();
				return store;
			})
		: Promise.resolve(undefined);
	void personalReady.catch(() => {});
	signal.throwIfAborted();
	const recorder = createRecorder({ localBlobs: local.blobs });
	// Navigation can fail or stall. Stop uncertain and pending capture immediately.
	signal.addEventListener(
		'abort',
		() => {
			void recorder.close().catch((cause) => log.error(cause));
		},
		{ once: true },
	);
	const playbackReady = preparePlaybackWorker();
	void playbackReady.catch(() => {});
	const inference = Promise.allSettled([
		account ? openEpicenterInference({ account }) : Promise.resolve(null),
		openRuntimeTranscriber(),
		account
			? openAccountConnectionCatalog({ account })
			: openLocalConnectionCatalog(),
	]).then(([hosted, runtime, connections]) => ({
		account: hosted.status === 'fulfilled' ? hosted.value : null,
		runtime: runtime.status === 'fulfilled' ? runtime.value : null,
		connections: connections.status === 'fulfilled' ? connections.value : null,
		errors: [hosted, runtime, connections].flatMap((result) =>
			result.status === 'rejected' ? [extractErrorMessage(result.reason)] : [],
		),
	}));
	return {
		personalReady,
		playbackReady,
		pendingSaves: createPendingSaves(signal),
		recorder,
		inference,
		signal,
	};
}
