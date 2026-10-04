import { auth } from '#platform/auth';
import { tauri } from '#platform/tauri';
import {
	TRANSCRIPTION_PROVIDERS,
	type TranscriptionProviderEntry,
} from '$lib/services/transcription/provider-ui';
import { deviceConfig } from '$lib/state/device-config.svelte';
import { localModels } from '$lib/state/local-models.svelte';
import { secrets } from '$lib/state/secrets.svelte';
import type { WhisperingApplication as WhisperingApp } from '$lib/whispering/application';

function hasValue(value: string) {
	return value.trim() !== '';
}

/**
 * Active readiness for the on-device provider. `localModels` is the source of
 * truth for presence; the deviceConfig key only holds the pointer, so a stored
 * id can point at a GGUF that was deleted from the shared cache, never finished
 * downloading, or was selected on another device and never downloaded here. A
 * non-empty id is not a runnable model:
 *
 *   - `unset`   nothing chosen              -> zero-choice empty state
 *   - `loading` first Rust scan not back    -> optimistic; don't flash a warning
 *   - `missing` id set but not downloaded   -> nudge to re-download or pick another
 *   - `ready`   the stored id is downloaded here
 */
export type LocalSelectionState = 'ready' | 'missing' | 'unset' | 'loading';

export function isLocalSelectionRunnable(): LocalSelectionState {
	const id = deviceConfig.get('transcription.local.selectedModel');
	if (!hasValue(id)) return 'unset';
	if (!localModels.loaded) return 'loading';
	return localModels.find(id)?.downloaded ? 'ready' : 'missing';
}

export function getSelectedTranscriptionProvider(
	app: WhisperingApp,
): TranscriptionProviderEntry | undefined {
	const selectedServiceId = app.settings.get('transcription.service');
	return TRANSCRIPTION_PROVIDERS.find((s) => s.id === selectedServiceId);
}

function isTranscriptionServiceAvailable(
	service: TranscriptionProviderEntry,
): boolean {
	return Boolean(tauri) || service.access !== 'onDevice';
}

/**
 * Gets the currently selected transcription service.
 * Returns undefined if the service is not available on this platform.
 *
 * @returns The selected transcription service, or undefined if none selected or invalid
 */
export function getSelectedTranscriptionService(
	app: WhisperingApp,
): TranscriptionProviderEntry | undefined {
	const service = getSelectedTranscriptionProvider(app);
	if (service && !isTranscriptionServiceAvailable(service)) return undefined;
	return service;
}

/**
 * Whether a transcription service is usable right now. The required key is the
 * provider's own config key (apiKey / endpoint / model), read from its registry
 * entry. A `key` provider's API key is a secret read through the credential facade,
 * so "usable" means `available`.
 *
 * @param service - The transcription service to check
 * @returns true if the service is usable, false otherwise
 */
export function isTranscriptionServiceConfigured(
	service: TranscriptionProviderEntry,
): boolean {
	switch (service.access) {
		case 'session':
			// No key to configure: the credential is the signed-in session, so
			// "configured" is "signed in". Metering and top-up live on the deployment.
			return auth.state.status === 'signed-in';
		case 'key':
			return secrets.get(service.apiKeyConfigKey).status === 'available';
		case 'endpoint':
			return (
				hasValue(deviceConfig.get(service.endpointConfigKey)) &&
				hasValue(deviceConfig.get(service.modelIdConfigKey))
			);
		case 'onDevice':
			// Store-backed, not "a non-empty key": a stored id pointing at a
			// deleted/never-downloaded GGUF must not pass as ready.
			return isLocalSelectionRunnable() === 'ready';
	}
}

export type TranscriptionReadiness = {
	/** True when the selected service is available here and fully configured. */
	isReady: boolean;
	/** The single most relevant blocker to show the user, or null when ready. */
	primaryIssue: string | null;
};

export function getTranscriptionReadiness(
	app: WhisperingApp,
): TranscriptionReadiness {
	const service = getSelectedTranscriptionProvider(app);
	if (!service) {
		return { isReady: false, primaryIssue: 'Choose a transcription service.' };
	}

	if (!isTranscriptionServiceAvailable(service)) {
		return {
			isReady: false,
			primaryIssue: `${service.label} is only available in the desktop app.`,
		};
	}

	// On-device readiness is store-backed and optimistic during the first scan:
	// a not-yet-loaded catalog must not flash a warning for a model that will
	// resolve to `ready` a tick later.
	if (service.access === 'onDevice') {
		const runnable = isLocalSelectionRunnable();
		if (runnable === 'ready' || runnable === 'loading') {
			return { isReady: true, primaryIssue: null };
		}
		return {
			isReady: false,
			primaryIssue:
				runnable === 'missing'
					? `Your ${service.label} model is not downloaded. Download it again or pick another.`
					: `Download a ${service.label} model to start transcribing.`,
		};
	}

	if (!isTranscriptionServiceConfigured(service)) {
		const primaryIssue = (
			{
				session: 'Sign in to Epicenter to use hosted transcription.',
				key: `Add your ${service.label} API key.`,
				endpoint: `Set your ${service.label} endpoint and model ID.`,
			} as const
		)[service.access];

		return { isReady: false, primaryIssue };
	}

	return { isReady: true, primaryIssue: null };
}
