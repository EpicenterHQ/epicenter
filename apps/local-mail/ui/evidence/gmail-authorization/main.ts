import { DEFAULT_MAIL_CONFIG } from '../../../src/config.js';
import { beginAuthorization } from '../../../src/oauth.js';
import { gmailAuthorization } from '../../src/lib/platform/gmail-authorization.browser.js';

let controller: AbortController | undefined;
const status = document.getElementById('status')!;
const evidence = {
	primary: crypto.randomUUID(),
	state: '',
	result: '',
	activation: false,
};
Object.assign(globalThis, { evidence });
document.getElementById('connect')!.onclick = async () => {
	controller = new AbortController();
	status.textContent = 'preparing';
	evidence.result = '';
	try {
		const delay = Number(
			(document.getElementById('delay') as HTMLInputElement).value,
		);
		if (delay) await new Promise((resolve) => setTimeout(resolve, delay));
		const request = await beginAuthorization({
			config: {
				...DEFAULT_MAIL_CONFIG,
				authorizeUrl: `${location.origin}/authorize.html`,
			},
			identity: { clientId: 'evidence', clientSecret: 'evidence' },
			redirectUri: `${location.origin}/connected`,
		});
		evidence.state = request.state;
		evidence.activation = navigator.userActivation.isActive;
		status.textContent = 'pending';
		const returned = await gmailAuthorization.authorize(
			request,
			controller.signal,
		);
		evidence.result = returned.href;
		status.textContent = 'returned';
	} catch (error) {
		evidence.result = error instanceof Error ? error.message : String(error);
		status.textContent = 'failed';
	}
};
document.getElementById('cancel')!.onclick = () => controller?.abort();

// This control distinguishes callback evidence from browser popup-policy proof.
if (new URL(location.href).searchParams.has('autostart')) {
	setTimeout(() => document.getElementById('connect')!.click(), 100);
}
