import { defineApplication } from '@epicenter/app';
import { createDeparture } from '@epicenter/app-shell/departure';
import { createBrowserInferenceSelections } from '@epicenter/app-shell/inference-selections';
import { initializeBrowserAiSettings } from '@epicenter/app-shell/migrate-ai-settings';
import { APPS } from '@epicenter/constants/apps';
import { Ok, trySync } from 'wellcrafted/result';
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
const shouldOpen =
	!new URLSearchParams(location.search).has('connect') &&
	(library === 'local' ||
		(account !== null && (library !== 'shared' || canOpenShared)));
if (shouldOpen) await initializeBrowserAiSettings('whispering');
export const selections = shouldOpen
	? createBrowserInferenceSelections('whispering')
	: null;
export const app = trySync({
	try: () => {
		if (new URLSearchParams(location.search).has('connect')) return null;
		if (library === 'local') return application.openLocal();
		if (account === null) return null;
		if (library === 'personal') return application.openPersonal(account);
		return canOpenShared ? application.openShared(account) : null;
	},
	catch(cause) {
		// Preserve the opening failure even if subscription cleanup also fails.
		trySync({
			try: () => selections?.[Symbol.dispose](),
			catch: () => Ok(undefined),
		});
		throw cause;
	},
}).data;
void app?.ready.then(({ error }) => {
	if (error) selections?.[Symbol.dispose]();
});
let closing = false;
export function isClosing() {
	return closing;
}

/** Release the concrete App, including an acquisition that failed before UI mount. */
export function closeApp() {
	closing = true;
	selections?.[Symbol.dispose]();
	return app?.close() ?? Promise.resolve();
}
export const departure = createDeparture({
	retirement: app && app.library !== 'local' ? app.retirement : undefined,
	reload: () => location.reload(),
	auth: app && app.library !== 'local' && auth ? auth : undefined,
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
