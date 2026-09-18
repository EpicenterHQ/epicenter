import { openApp } from '@epicenter/app/open';
import { createDeparture } from '@epicenter/app-shell/departure';
import { authStartup } from '#platform/auth';
import { mailDefinition } from './data.js';
import { mail } from './mail.js';

// Only the mounted primary route imports this module. The document captures
// its Account once; callback and preload routes never acquire a library.
const auth = authStartup.auth;
export const account = auth?.state.account;
export const opening =
	account === undefined || new URLSearchParams(location.search).has('connect')
		? undefined
		: openApp(mailDefinition, { account });

export const departure = createDeparture({
	opening,
	auth: opening ? (auth ?? undefined) : undefined,
	account,
	beforeClose: () => mail.close(),
});
