import { auth } from '$lib/auth.svelte.js';
import { tauri } from '#platform/tauri';
import {
	TRANSCRIPTION_PROVIDERS,
	type TranscriptionProviderEntry,
} from '$lib/services/transcription/provider-ui';
import { deviceConfig } from '$lib/state/device-config.svelte';
import { localRoute } from '$lib/state/local-route.svelte';
import { secrets } from '$lib/state/secrets.svelte';
import type { WhisperingApp } from '$lib/whispering/app';

function hasValue(value: string) {
	return value.trim() !== '';
}

/**
 * The host's own sentence for why the local route cannot run, or `null` when it
 * can. Presented verbatim: the host reports the fact, and it is written to name
 * no model, because model identity is administration data (ADR-0180).
 */
export function getLocalRouteBlocker(): string | null {
	return localRoute.result?.error?.message ?? null;
}

export function getSelectedTranscriptionProvider(
	app: WhisperingApp,
): TranscriptionProviderEntry | undefined {
	const selectedServiceId = app.settings.get('transcriptionService');
	return TRANSCRIPTION_PROVIDERS.find((s) => s.id === selectedServiceId);
}

export function isTranscriptionServiceAvailable(
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
			// The local route needs no app-side configuration at all: there is no
			// key, no endpoint, and no model for Whispering to set. On desktop it is
			// always "configured", so it stays selectable even when the host cannot
			// currently run it. That is deliberate (ADR-0180): a selectable route
			// that warns is what lets the warning happen before capture, and hiding
			// the route would leave the user with nothing to warn about.
			return true;
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

	// On-device readiness is host-advised and optimistic during the first read: a
	// not-yet-answered host must not flash a warning for a route that resolves to
	// `ready` a tick later. The blocker is the host's own sentence, shown as-is.
	if (service.access === 'onDevice') {
		const blocker = getLocalRouteBlocker();
		return blocker === null
			? { isReady: true, primaryIssue: null }
			: { isReady: false, primaryIssue: blocker };
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
