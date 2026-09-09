import { defineApplication } from '@epicenter/app';
import { createDeparture } from '@epicenter/app-shell/departure';
import { APPS } from '@epicenter/constants/apps';
import { ai } from '#platform/ai';
import { authClient } from '#platform/auth';
import { runtime } from '#platform/runtime';
import { whisperingDefinition } from './data.js';

// Loaded only by the mounted application opening path.
const auth = authClient.auth;
const state = auth?.state;
const signedInAccount =
	!state || state.status === 'signed-out' ? null : state.account;
export type Library = 'local' | 'personal' | 'shared';
export const library: Library = (() => {
	const saved = localStorage.getItem('whispering.library');
	if (saved === null) return signedInAccount === null ? 'local' : 'personal';
	if (saved === 'local' || saved === 'personal' || saved === 'shared')
		return saved;
	throw new Error('Your saved library choice could not be read.');
})();
export const canOpenShared = authClient.selectedServer !== null;
// A Local App never borrows inference or remote storage from ambient sign-in.
export const account = library === 'local' ? null : signedInAccount;
const application = defineApplication({
	appId: APPS.WHISPERING.id,
	definition: whisperingDefinition,
	runtime,
	ai,
});
export const app = (() => {
	if (new URLSearchParams(location.search).has('connect')) return null;
	if (library === 'local') return application.openLocal();
	if (account === null) return null;
	if (library === 'personal') return application.openPersonal(account);
	return canOpenShared ? application.openShared(account) : null;
})();
let closing = false;
export function isClosing() {
	return closing;
}

/** Release the concrete App, including an acquisition that failed before UI mount. */
export function closeApp() {
	closing = true;
	return app?.close() ?? Promise.resolve();
}
export const departure = createDeparture({
	retirement: app?.retirement,
	reload: () => location.reload(),
	auth: app && library !== 'local' && auth ? auth : undefined,
	account,
	close: closeApp,
});

export function selectLibrary(next: Library) {
	if (next === library) return Promise.resolve();
	return departure.go(() => {
		localStorage.setItem('whispering.library', next);
		location.assign(location.pathname);
	});
}
