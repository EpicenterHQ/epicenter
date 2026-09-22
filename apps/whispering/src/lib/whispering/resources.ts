import {
	openEpicenterInference,
	openRuntimeTranscriber,
} from '@epicenter/app/ai';
import {
	openAccountConnectionCatalog,
	openLocalConnectionCatalog,
} from '@epicenter/app/ai-connections';
import { openLocal, openPersonal } from '@epicenter/app/open';
import { createRecorder } from '@epicenter/app/recorder';
import type { Account } from '@epicenter/auth';
import { extractErrorMessage } from 'wellcrafted/error';
import { createLogger } from 'wellcrafted/logger';
import { whisperingDefinition } from '../data.js';

const log = createLogger('whispering/resources');

/** Root handles belong to this browser/WebView. The signal fences workflow work. */
export async function openWhisperingResources(
	account: Account | undefined,
	signal: AbortSignal,
) {
	signal.throwIfAborted();
	const local = await openLocal(whisperingDefinition);
	signal.throwIfAborted();
	const personal = account
		? await openPersonal(whisperingDefinition, { account })
		: undefined;
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
		local,
		personal,
		localBlobs: local.blobs,
		remoteBlobs: personal?.blobs ?? null,
		recorder,
		inference,
		signal,
	};
}
