import { createContext } from 'svelte';
import type { WhisperingQueries } from '$lib/queries';
import type { WhisperingApp } from './app';

/**
 * The selected reactive library, device settings, and live recording workflow.
 * Operation modules receive this explicitly; components read it from context.
 */
export type WhisperingContext = {
	app: WhisperingApp;
	queries: WhisperingQueries;
};

/**
 * Typed context supplied synchronously by `WhisperingShell` inside the `ready`
 * branch of the boot node. The focused getters below are ready-only by
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
