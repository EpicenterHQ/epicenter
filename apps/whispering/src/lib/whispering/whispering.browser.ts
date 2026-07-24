import { auth } from '#platform/auth';
import { BlobsLive } from '#platform/blobs';
import { log } from '$lib/report';
import type { WhisperingAppDependencies } from './app';
import {
	createWhisperingUnclaimedImport,
	type WhisperingUnclaimedImport,
} from './import-unclaimed';
import { openWhisperingBrowserEpicenter } from './whispering.browser-runtime';

/**
 * The web build's app dependencies. Pure data and factories: nothing
 * here opens storage or starts fallible work. The (app) layout passes this to
 * `openWhisperingApp` inside the mounted Svelte root, where the raw
 * `{#await}` owns the acquisition from its first microtask. Authentication
 * selects the replica at open (ADR-0178); auth changes reopen the session.
 */
export const whisperingPlatform: WhisperingAppDependencies = {
	openEpicenter: () => openWhisperingBrowserEpicenter({ auth }),
	blobs: BlobsLive,
	defaultTranscriptionService: 'OpenAI',
	reportBackgroundError: (cause) =>
		log.warn(
			cause instanceof Error ? cause : new Error(String(cause)),
			'Whispering app background failure',
		),
};

/**
 * Explicit import from the unclaimed replica into the signed-in account
 * (ADR-0178). Only the web build owns an account replica, so only it offers
 * the capability.
 */
export const unclaimedImport: WhisperingUnclaimedImport | undefined =
	createWhisperingUnclaimedImport(auth);
