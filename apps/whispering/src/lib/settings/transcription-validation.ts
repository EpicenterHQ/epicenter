import {
	TRANSCRIPTION_PROVIDERS,
	type TranscriptionProviderEntry,
} from '../services/transcription/provider-ui.js';
import { secrets } from '../state/secrets.svelte.js';
import type { WhisperingApp } from '../whispering/app.js';

export function getSelectedTranscriptionProvider(app: WhisperingApp) {
	return TRANSCRIPTION_PROVIDERS.find(
		(service) => service.id === app.settings.get('transcriptionService'),
	);
}

/** Standard protocols use an explicit connection; these providers retain distinct protocols. */
export function isTranscriptionServiceAvailable(
	service: TranscriptionProviderEntry,
): boolean {
	return (
		service.id === 'connection' ||
		service.id === 'Deepgram' ||
		service.id === 'ElevenLabs' ||
		service.id === 'Mistral'
	);
}

export function getSelectedTranscriptionService(app: WhisperingApp) {
	const service = getSelectedTranscriptionProvider(app);
	return service && isTranscriptionServiceAvailable(service)
		? service
		: undefined;
}

export function isTranscriptionServiceConfigured(
	service: TranscriptionProviderEntry,
	app: WhisperingApp,
): boolean {
	if (service.access === 'connection')
		return app.inferenceConnections.canServe(
			'transcription',
			app.settings.get('transcriptionModel'),
		);
	if (service.access === 'key' && isTranscriptionServiceAvailable(service))
		return secrets.get(service.apiKeyConfigKey).status === 'available';
	return false;
}

export type TranscriptionReadiness = {
	isReady: boolean;
	primaryIssue: string | null;
};

export function getTranscriptionReadiness(
	app: WhisperingApp,
): TranscriptionReadiness {
	const service = getSelectedTranscriptionService(app);
	if (!service)
		return {
			isReady: false,
			primaryIssue:
				'Choose a transcription connection and model. You can import your saved provider settings.',
		};
	if (!isTranscriptionServiceConfigured(service, app))
		return {
			isReady: false,
			primaryIssue:
				service.access === 'connection'
					? 'Choose an available transcription connection and model.'
					: `Add your ${service.label} API key.`,
		};
	return { isReady: true, primaryIssue: null };
}
