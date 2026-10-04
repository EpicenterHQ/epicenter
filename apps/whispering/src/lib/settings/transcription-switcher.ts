/**
 * The recorder switcher's row source: `readyModels()`, a flat list of the
 * transcription routes usable *right now*. It is a union of two honestly
 * different producers (see the reconciliation spec):
 *
 *  - the static non-onDevice provider registry (`session` / `key` / `endpoint`),
 *    filtered to the ones configured, one leaf each; and
 *  - the live on-device catalog (`localModels`), filtered to the downloaded
 *    GGUFs, one leaf per model.
 *
 * Same leaf shape, different provenance. Each producer computes its own
 * `title` (and exact-model fields) where it already reads its own store, so
 * the selector does not need cross-store display branching.
 * Reactive by construction: the getters it reads (`settings`, `secrets`,
 * `auth`, `deviceConfig`, `localModels`) are all reactive, so calling this
 * inside a `$derived` re-runs it when any source changes.
 */
import { tauri } from '#platform/tauri';
import {
	PROVIDER_ICONS,
	TRANSCRIPTION_PROVIDERS,
	type TranscriptionProviderEntry,
} from '$lib/services/transcription/provider-ui';
import type { TranscriptionServiceId } from '$lib/services/transcription/providers';
import { deviceConfig } from '$lib/state/device-config.svelte';
import { localModels } from '$lib/state/local-models.svelte';
import type { ModelInfo } from '$lib/tauri/commands.types';
import type { WhisperingApp } from '$lib/whispering/context';
import { isTranscriptionServiceConfigured } from './transcription-validation';

/**
 * One switchable transcription route. The union's single row shape: an icon,
 * an identity, the exact model truth, where it runs, a check if active, and
 * how to make it active. Each producer fills `title`/`modelId`/`endpointHost`
 * from the store it owns.
 */
export type SwitcherLeaf = {
	/** Stable list/cmdk key. remote providers: providerId. onDevice: model id. */
	key: string;
	providerId: TranscriptionServiceId;
	access: 'session' | 'key' | 'endpoint' | 'onDevice';
	/** Brand glyph markup from `PROVIDER_ICONS` (local shares the ggml icon). */
	icon: string;
	invertInDarkMode: boolean;
	/**
	 * The route's identity: the compact pipeline trigger's text and the picker
	 * row's primary line. onDevice -> the curated model name ("Whisper Small");
	 * every remote access -> the provider label ("Epicenter", "OpenAI",
	 * "Speaches"). Unambiguous today because every remote provider produces
	 * exactly one leaf, and each on-device leaf IS a model.
	 */
	title: string;
	/**
	 * The exact model id this route will run, the confirmation #2337 asked for:
	 * key -> the committed model setting; endpoint -> the configured server
	 * model id. Absent where the id adds nothing over the title: session runs
	 * the gateway-pinned wire model, and an onDevice title already names its
	 * model (the opaque HF coordinate stays searchable via `keywords` and
	 * visible in settings).
	 */
	modelId?: string;
	/** endpoint only: the configured server's host, so the row also answers
	 *  "which box runs this model" next to `modelId`. */
	endpointHost?: string;
	/** The cmdk search string (also its unique `value`). */
	keywords: string;
	/** True when this leaf is the current active selection. */
	isActive: boolean;
	/** Write today's selection keys to make this the active route. */
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

/** Every non-onDevice provider: reached over the wire, one committed leaf each. */
type RemoteEntry = Extract<
	TranscriptionProviderEntry,
	{ access: 'session' | 'key' | 'endpoint' }
>;

const REMOTE_ENTRIES = TRANSCRIPTION_PROVIDERS.filter(
	(entry): entry is RemoteEntry => entry.access !== 'onDevice',
);

/** A committed remote provider -> its one switcher leaf. */
function toRemoteLeaf(app: WhisperingApp, entry: RemoteEntry): SwitcherLeaf {
	const base = {
		key: entry.id,
		providerId: entry.id,
		icon: entry.icon,
		invertInDarkMode: entry.invertInDarkMode,
		isActive: app.settings.get('transcription.service') === entry.id,
		select: () => app.settings.set('transcription.service', entry.id),
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
			// The provider is the route's identity; the committed model (set once in
			// setup) rides along as the exact-model confirmation.
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
			// The provider is the identity here too; the configured model id (#2337)
			// and the server host stay on the leaf as exact truth.
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
	}
}

/** A downloaded on-device GGUF -> its one switcher leaf. */
function toLocalLeaf(app: WhisperingApp, model: ModelInfo): SwitcherLeaf {
	return {
		key: model.id,
		providerId: 'local',
		access: 'onDevice',
		icon: PROVIDER_ICONS.local.icon,
		invertInDarkMode: PROVIDER_ICONS.local.invertInDarkMode,
		title: model.name,
		keywords: `${model.id} ${model.name} ${model.description} local on-device offline gguf whisper private`,
		isActive:
			app.settings.get('transcription.service') === 'local' &&
			deviceConfig.get('transcription.local.selectedModel') === model.id,
		select: () => {
			app.settings.set('transcription.service', 'local');
			deviceConfig.set('transcription.local.selectedModel', model.id);
		},
	};
}

/**
 * The switcher's row source: on-device leaves first (privacy-forward), then the
 * committed remote routes. On-device is empty off Tauri (the store never scans
 * on web). Membership is the store's own per-model `downloaded` verdict, never
 * the raw deviceConfig pointer.
 */
export function readyModels(app: WhisperingApp): SwitcherLeaf[] {
	const remote = REMOTE_ENTRIES.filter((entry) =>
		isTranscriptionServiceConfigured(entry),
	).map((entry) => toRemoteLeaf(app, entry));
	const onDevice = tauri
		? localModels.models
				.filter((model) => model.downloaded)
				.map((model) => toLocalLeaf(app, model))
		: [];
	return [...onDevice, ...remote];
}
