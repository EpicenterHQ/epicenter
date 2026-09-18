import type { WhisperingApp } from '../whispering/app.js';

/** Readiness uses the same exact connection and model as transcription. */
export function getTranscriptionReadiness(app: WhisperingApp) {
	const isReady = app.inferenceConnections.canServe(
		'transcription',
		app.settings.get('transcriptionModel'),
	);
	return {
		isReady,
		primaryIssue: isReady
			? null
			: 'Choose an available transcription connection and model.',
	};
}
