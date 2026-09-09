import {
	PROVIDERS,
	type TranscriptionServiceId,
} from '../services/transcription/providers.js';
import type { DeviceConfigKey } from '../state/device-config.svelte.js';
import { hostFromBaseUrl } from './locality.js';

type TranscriptionEndpointKey = Extract<
	DeviceConfigKey,
	`providers.${string}.endpoint`
>;

/**
 * Describe the selected transcription operation. An HTTP address identifies the
 * request's first destination, not whether that server forwards audio elsewhere.
 * Native inference runs on-device; recording backup is a separate operation.
 */
export function describeTranscriptionDestinationFromConfig({
	service,
	getDeviceConfig,
}: {
	service: TranscriptionServiceId;
	getDeviceConfig: (key: TranscriptionEndpointKey) => string;
}): string {
	const provider = PROVIDERS[service];
	if (provider.access === 'connection')
		return 'Transcription uses your selected connection and model.';
	if (provider.access === 'onDevice') return 'Transcribed on this device.';
	if (provider.access === 'session') return 'Transcription via Epicenter.';
	const endpoint = provider.endpointConfigKey
		? getDeviceConfig(
				provider.endpointConfigKey as TranscriptionEndpointKey,
			).trim()
		: '';
	if (endpoint) return `Transcription via ${hostFromBaseUrl(endpoint)}.`;
	if (provider.access === 'endpoint') return 'Add a transcription server URL.';
	return `Transcription via ${provider.label}.`;
}
