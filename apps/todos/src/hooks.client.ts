/**
 * A world that did not open (`StartupFailed`) reaches the error page with
 * what its recovery screen needs. Any other error is logged, as SvelteKit's
 * default hook does, and reaches the page as its status message.
 */
import type { HandleClientError } from '@sveltejs/kit';
import { StartupFailed } from '$lib/startup.js';

export const handleError: HandleClientError = ({ error, message }) => {
	if (error instanceof StartupFailed)
		return { message: error.message, startup: error.failure };
	console.error(error);
	return { message };
};
