import { auth } from '#platform/auth';
import { log } from '$lib/report';
import { requireFinalizedAudioBytes } from '../services/recorder/contract';
import type { WhisperingAppDependencies } from './app';
import { openWhisperingBrowserEpicenter } from './whispering.browser-runtime';

/**
 * The web build's app dependencies. Pure data and factories: nothing
 * here opens storage or starts fallible work. The (app) layout passes this to
 * `openWhisperingApp` inside the mounted Svelte root, where the raw
 * `{#await}` owns the acquisition from its first microtask.
 */
export const whisperingPlatform: WhisperingAppDependencies = {
	openEpicenter: () =>
		openWhisperingBrowserEpicenter({
			auth,
			reportBackgroundError: (cause) =>
				log.warn(
					cause instanceof Error ? cause : new Error(String(cause)),
					'Whispering sync failure',
				),
		}),
	prepareAudio: requireFinalizedAudioBytes,
	materializeAudio: async (audio) => audio,
	defaultTranscriptionService: 'OpenAI',
	reportBackgroundError: (cause) =>
		log.warn(
			cause instanceof Error ? cause : new Error(String(cause)),
			'Whispering app background failure',
		),
};
