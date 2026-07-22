import {
	type DesktopRecordBlobSource,
	openDesktopRecordEpicenter,
} from '@epicenter/data/desktop-record';
import { log } from '$lib/report';
import {
	EPICENTER_DESKTOP_AI_BASE_ROUTE,
	whisperingDesktopAudioUrl,
} from '$lib/workspace';
import type { WhisperingAppDependencies } from './app';

/**
 * The Epicenter-hosted build's app dependencies. Pure data and
 * factories: the WebView runtime performs its honest host open handshake only
 * once `openWhisperingApp` runs inside the mounted Svelte root.
 */
export const whisperingPlatform: WhisperingAppDependencies<
	Blob,
	Blob,
	DesktopRecordBlobSource
> = {
	openEpicenter: openDesktopRecordEpicenter,
	prepareAudio: (audio) =>
		audio.kind === 'bytes'
			? { kind: 'bytes', bytes: audio.bytes }
			: {
					kind: 'native-capture',
					captureId: audio.captureId,
					byteLength: audio.byteLength,
				},
	materializeAudio: async (audio) => audio,
	async readAudio(id, mediaType) {
		const response = await fetch(
			whisperingDesktopAudioUrl(globalThis.location.origin, id),
			{ credentials: 'same-origin' },
		);
		if (response.status === 404) return null;
		if (!response.ok) {
			throw new Error(`Desktop recording audio HTTP ${response.status}`);
		}
		return new Blob([await response.blob()], { type: mediaType });
	},
	audioUrl: (id) => whisperingDesktopAudioUrl(globalThis.location.origin, id),
	beginAuthenticatedRequest: () => ({
		baseURL: new URL(
			EPICENTER_DESKTOP_AI_BASE_ROUTE,
			globalThis.location.origin,
		).toString(),
		fetch: globalThis.fetch.bind(globalThis),
	}),
	defaultTranscriptionService: 'local',
	reportBackgroundError: (cause) =>
		log.warn(
			cause instanceof Error ? cause : new Error(String(cause)),
			'Whispering app background failure',
		),
};
