import type { GmailAuthorization } from './types.js';

/** The primary document retains the verifier, App, and browser credentials. */
export const gmailAuthorization: GmailAuthorization = {
	authorize(request, signal) {
		signal.throwIfAborted();
		const popup = window.open(
			request.authorizeUrl,
			'_blank',
			'popup,width=600,height=750',
		);
		if (!popup)
			return Promise.reject(
				new Error('Allow pop-up windows to connect Gmail.'),
			);
		return new Promise<URL>((resolve, reject) => {
			function finish(error?: Error, url?: URL) {
				window.removeEventListener('message', receive);
				signal.removeEventListener('abort', abort);
				clearInterval(poll);
				clearTimeout(timeout);
				popup?.close();
				if (error) reject(error);
				else if (url) resolve(url);
			}
			function abort() {
				finish(new Error('Gmail connection cancelled.'));
			}
			function receive(event: MessageEvent) {
				if (event.origin !== location.origin || event.source !== popup) return;
				if (
					event.data?.type !== 'local-mail-gmail-return' ||
					typeof event.data.url !== 'string'
				)
					return;
				try {
					const url = new URL(event.data.url);
					if (
						url.origin !== location.origin ||
						url.pathname !== new URL(request.redirectUri).pathname
					)
						return;
					finish(undefined, url);
				} catch {
					/* Ignore unrelated malformed messages. */
				}
			}
			window.addEventListener('message', receive);
			signal.addEventListener('abort', abort, { once: true });
			const poll = setInterval(() => {
				if (popup.closed) finish(new Error('Gmail connection window closed.'));
			}, 500);
			const timeout = setTimeout(
				() => finish(new Error('Gmail connection timed out. Try again.')),
				300_000,
			);
		});
	},
};

export const gmailSignInNotice =
	'This browser keeps your Gmail sign-in in memory. Refreshing or closing the tab clears it. Downloaded mail, saved queries, and pending changes stay on this device.';
