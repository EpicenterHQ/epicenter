import { openBrowserEpicenter } from '@epicenter/data/runtime/browser';
import { BlobsLive } from '#platform/blobs';
import { log } from '$lib/report';
import type { WhisperingAppDependencies } from './app';
import type { WhisperingUnclaimedImport } from './import-unclaimed';

/**
 * The Epicenter-hosted build's app dependencies. Pure data and
 * factories: the WebView runtime performs its honest host open handshake only
 * once `openWhisperingApp` runs inside the mounted Svelte root. This build
 * has no account replica wired yet, so it opens the WebView origin's
 * unclaimed replica (ADR-0178) and offers no import capability.
 */
export const whisperingPlatform: WhisperingAppDependencies = {
	openEpicenter: () => openBrowserEpicenter({ owner: null }),
	blobs: BlobsLive,
	defaultTranscriptionService: 'local',
	reportBackgroundError: (cause) =>
		log.warn(
			cause instanceof Error ? cause : new Error(String(cause)),
			'Whispering app background failure',
		),
};

export const unclaimedImport: WhisperingUnclaimedImport | undefined = undefined;
