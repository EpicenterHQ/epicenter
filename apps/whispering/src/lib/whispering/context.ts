import { createContext } from 'svelte';
import type { WhisperingQueries } from '$lib/queries';
import type { WhisperingApp } from './app';
import type { RecordingEditor } from './recording-editor.js';

/**
 * The ready app as descendants of the fulfilled boot branch see it:
 * the UI-free product namespaces wrapped with Svelte dependency tracking.
 * Operation modules receive this explicitly; components read it from context.
 */
export type WhisperingContext = {
	app: WhisperingApp;
	queries: WhisperingQueries;
	recordingEditor: RecordingEditor;
};

/**
 * Typed context supplied synchronously by `WhisperingUiSessionProvider` inside the
 * fulfilled boot branch. The focused getters below are ready-only by
 * construction: nothing outside that branch can reach either dependency.
 */
const [getWhisperingContext, setWhisperingContext] =
	createContext<WhisperingContext>();

export { setWhisperingContext };

export function getWhisperingApp() {
	return getWhisperingContext().app;
}

export function getWhisperingQueries() {
	return getWhisperingContext().queries;
}

export function getRecordingEditor() {
	return getWhisperingContext().recordingEditor;
}
