import { createContext } from 'svelte';
import type { WhisperingQueries } from '$lib/queries';
import type { WhisperingApp } from './app';

/**
 * The document-owned recording workflow and resources.
 * Operation modules receive this explicitly; components read it from context.
 */
export type WhisperingContext = {
	app: WhisperingApp;
};

/**
 * Typed context supplied synchronously by `WhisperingShell` inside the `ready`
 * branch of the boot node. The App getter is ready-only by construction. Recording views provide their own
 * concrete-store query context.
 */
const [getWhisperingContext, setWhisperingContext] =
	createContext<WhisperingContext>();

export { setWhisperingContext };

export function getWhisperingApp() {
	return getWhisperingContext().app;
}

export const [getWhisperingQueries, setWhisperingQueries] =
	createContext<WhisperingQueries>();
