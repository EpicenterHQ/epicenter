import { createContext } from 'svelte';
import type { WhisperingQueries } from '$lib/queries';
import type { WhisperingApplication } from './application';

/**
 * The ready application as descendants of the fulfilled boot branch see it:
 * the UI-free product namespaces wrapped with Svelte dependency tracking.
 * Operation modules receive this explicitly; components read it from context.
 */
export type WhisperingContext = {
	application: WhisperingApplication;
	queries: WhisperingQueries;
};

/**
 * Typed context supplied synchronously by `WhisperingAppProvider` inside the
 * fulfilled boot branch. The focused getters below are ready-only by
 * construction: nothing outside that branch can reach either dependency.
 */
const [getWhisperingContext, setWhisperingContext] =
	createContext<WhisperingContext>();

export { setWhisperingContext };

export function getWhisperingApp() {
	return getWhisperingContext().application;
}

export function getWhisperingQueries() {
	return getWhisperingContext().queries;
}
