import { openApp } from '@epicenter/app/open';
import { createDeparture } from '@epicenter/app-shell/departure';
import { createBrowserInferenceSelections } from '@epicenter/app-shell/inference-selections';
import { Ok, trySync } from 'wellcrafted/result';
import { authClient } from '#platform/auth';
import { whisperingDefinition } from './data.js';

// Loaded only by the mounted application opening path.
const auth = authClient.auth;
export const account = auth?.state.account;
export type Library = 'local' | 'personal' | 'shared';
export const library: Library = (() => {
	if (account === undefined) return 'local';
	const saved = localStorage.getItem('whispering.library');
	if (saved === null) return 'personal';
	if (saved === 'local' || saved === 'personal' || saved === 'shared')
		return saved;
	throw new Error('Your saved library choice could not be read.');
})();
export const canOpenShared = authClient.selectedServer !== null;
const shouldOpen = !new URLSearchParams(location.search).has('connect');
export const selections = shouldOpen
	? createBrowserInferenceSelections('whispering', account)
	: null;
export const app = trySync({
	try: () => {
		if (new URLSearchParams(location.search).has('connect')) return null;
		return openApp(whisperingDefinition, account);
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
export const data =
	library === 'local'
		? app?.device
		: library === 'personal'
			? app?.account?.personal
			: app?.account?.shared;
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
	libraryReplaced: app?.libraryReplaced,
	canRetryClose: () => app?.canRetryClose ?? false,
	reload: () => location.reload(),
	auth: app && auth ? auth : undefined,
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
