/**
 * `#platform/gmail-authorization` for the standalone web build.
 *
 * Leaving the page IS the flow, so this leaf owns the note that survives it.
 * `sessionStorage` is the right lifetime and the `connected` route is the
 * reader; nothing else in the application has to know that a redirect happened.
 */

import { rememberAuthorization } from '../connect.js';
import type { GmailAuthorization } from './types';

export const gmailAuthorization: GmailAuthorization = {
	authorize(request, signal) {
		signal.throwIfAborted();
		rememberAuthorization(request);
		window.location.assign(request.authorizeUrl);
		// Unreachable in practice: the tab is navigating away. Answering with a
		// promise that never settles keeps the caller's one shape, rather than
		// inventing a callback URL this build will never see.
		return new Promise<URL>((_resolve, reject) => {
			signal.addEventListener('abort', () => reject(signal.reason), {
				once: true,
			});
		});
	},
};
