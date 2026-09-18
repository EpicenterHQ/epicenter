import type { InferenceSelections } from '@epicenter/app-shell/inference-selections';
import type { WhisperingAppHandle } from './whispering/app.js';

// Product operations are invoked outside Svelte. The mounted shell supplies
// their actual App and keeps it available until admitted work has drained.
let application:
	| { app: WhisperingAppHandle; selections: InferenceSelections }
	| undefined;

export function attachApplication(
	app: WhisperingAppHandle,
	selections: InferenceSelections,
) {
	if (application)
		throw new Error('Whispering already has a mounted application.');
	application = { app, selections };
	return () => {
		application = undefined;
	};
}

export function getApp() {
	if (!application || application.app.signal.aborted)
		throw new Error('Whispering is not ready or is closing.');
	return application.app;
}

export function getSelections() {
	getApp();
	return application!.selections;
}
