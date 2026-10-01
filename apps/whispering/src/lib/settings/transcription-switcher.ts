/**
 * The recorder switcher's row source: `readyTranscribers()`, a flat list of the
 * transcription routes usable *right now*, one per configured provider.
 *
 * Every route contributes exactly one row, on-device included. Choosing "Local"
 * picks a route; it does not pick a model, because the host owns the one active
 * local model and Epicenter Home administers it (ADR-0180). The local row names
 * no model at all: model identity is administration data this app never
 * receives, and a row that named one would be a picker growing back.
 *
 * The local row is present on desktop whether or not the host can currently run
 * it, so the selector can warn about it. Readiness is surfaced as a warning by
 * `getTranscriptionReadiness`, not by making the route disappear.
 *
 * Reactive by construction: the getters it reads (`settings`, `secrets`,
 * `auth`, `deviceConfig`) are all reactive, so calling this inside a `$derived`
 * re-runs it when any source changes.
 */
import {
	TRANSCRIPTION_PROVIDERS,
	type TranscriptionProviderEntry,
} from '$lib/services/transcription/provider-ui';
import { deviceConfig } from '$lib/state/device-config.svelte';
import type { WhisperingApp } from '$lib/whispering/app';
import {
	isTranscriptionServiceAvailable,
	isTranscriptionServiceConfigured,
} from './transcription-validation';

/**
 * One ready transcriber: a configured route that can turn captured audio into
 * text immediately.
 */
export type Transcriber = {
	/** Stable list/cmdk key: the provider id. */
	key: string;
	access: 'session' | 'key' | 'endpoint' | 'onDevice';
	/** Brand glyph markup from the provider registry. */
	icon: string;
	invertInDarkMode: boolean;
	/** The compact trigger and row title: the provider label. */
	title: string;
	/**
	 * The exact model this route will use, where the app owns that choice. Keyed
	 * and endpoint providers configure a model here; on-device never does,
	 * because the host owns it and does not report it.
	 */
	modelId?: string;
	/** The endpoint provider's configured host. */
	endpointHost?: string;
	/** The cmdk search string (also its unique `value`). */
	keywords: string;
	/** True when this transcriber is the current active selection. */
	isActive: boolean;
	/** Make this the active transcription route. */
	select: () => void;
};

/** The endpoint provider's host; the raw string if it won't parse. */
function endpointHost(endpoint: string): string {
	try {
		return new URL(endpoint).host || endpoint;
	} catch {
		return endpoint;
	}
}

/** A configured provider -> its one ready transcriber. */
function toTranscriber(
	app: WhisperingApp,
	entry: TranscriptionProviderEntry,
): Transcriber {
	// Selecting a route writes exactly one setting. Picking a local model is a
	// separate act by a different owner (Home), which is the point of ADR-0180.
	const base = {
		key: entry.id,
		icon: entry.icon,
		invertInDarkMode: entry.invertInDarkMode,
		isActive: app.settings.get('transcriptionService') === entry.id,
		select: () => app.settings.set('transcriptionService', entry.id),
	};
	switch (entry.access) {
		case 'session':
			// Fixed wire model, metered by duration: the provider name is the whole
			// story, no model shown.
			return {
				...base,
				access: 'session',
				title: entry.label,
				keywords: `${entry.id} ${entry.label} epicenter hosted account credits`,
			};
		case 'key': {
			// The provider is the route identity; the committed model remains visible
			// as exact context in the expanded row.
			const model =
				app.settings.get(entry.modelSettingKey) || entry.defaultModel;
			return {
				...base,
				access: 'key',
				title: entry.label,
				modelId: model,
				keywords: `${entry.id} ${entry.label} ${model} cloud api key`,
			};
		}
		case 'endpoint': {
			// Carry host + modelId so the selector can show `host · modelId`
			// for the active self-hosted route (#2337).
			const endpoint = deviceConfig.get(entry.endpointConfigKey);
			const modelId = deviceConfig.get(entry.modelIdConfigKey);
			return {
				...base,
				access: 'endpoint',
				title: entry.label,
				modelId,
				endpointHost: endpointHost(endpoint),
				keywords: `${entry.id} ${entry.label} ${modelId} ${endpoint} custom server self-hosted`,
			};
		}
		case 'onDevice':
			// No `modelId`: which model runs is the host's, and naming it here
			// would hand this app an identity it is not given (ADR-0180).
			return {
				...base,
				access: 'onDevice',
				title: entry.label,
				keywords: `${entry.id} ${entry.label} local on-device offline private`,
			};
	}
}

/**
 * The switcher's row source: on-device first (privacy-forward), then the
 * configured remote services. Membership is `isTranscriptionServiceConfigured`
 * for every route alike, which for on-device is simply "we are on desktop":
 * the local route takes no app-side configuration.
 */
export function readyTranscribers(app: WhisperingApp): Transcriber[] {
	const ready = TRANSCRIPTION_PROVIDERS.filter(
		(entry) =>
			isTranscriptionServiceAvailable(entry) &&
			isTranscriptionServiceConfigured(entry),
	).map((entry) => toTranscriber(app, entry));
	return [
		...ready.filter((transcriber) => transcriber.access === 'onDevice'),
		...ready.filter((transcriber) => transcriber.access !== 'onDevice'),
	];
}
