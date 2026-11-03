/**
 * A world that did not open (`StartupFailed`) reaches the error page with
 * what its recovery screen needs; any other error is its message.
 */
import type { HandleClientError } from '@sveltejs/kit';
import { StartupFailed } from '$lib/startup.js';

export const handleError: HandleClientError = ({ error, message }) =>
	error instanceof StartupFailed
		? { message: error.message, startup: error.failure }
		: { message };
