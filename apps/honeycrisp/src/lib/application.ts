import { createEpicenter } from '@epicenter/app';
import { createBrowserAppBlobs } from '@epicenter/app/browser';
import { createDeparture } from '@epicenter/app-shell/departure';
import { APPS } from '@epicenter/constants/apps';
import { authStartup } from '#platform/auth';
import { sqlite } from '#platform/sqlite';
import { honeycrispDefinition } from './data.js';

// Imported only after the application route mounts. Module lifetime fixes
// the library, Account, and App across navigation in this document.
const auth = authStartup.auth;
const state = auth?.state;
export const account =
	!state || state.status === 'signed-out' ? null : state.account;
export type Library = 'local' | 'personal' | 'shared';
export const library: Library = (() => {
	const saved = localStorage.getItem('honeycrisp.library');
	if (saved === null) return account === null ? 'local' : 'personal';
	if (saved === 'local' || saved === 'personal' || saved === 'shared')
		return saved;
	throw new Error('Your saved library choice could not be read.');
})();
export const canOpenShared = authStartup.selectedServer !== null;
const application = createEpicenter({
	appId: APPS.HONEYCRISP.id,
	sqlite,
	blobs: createBrowserAppBlobs(),
	definition: honeycrispDefinition,
});
export const app = (() => {
	if (new URLSearchParams(location.search).has('connect')) return null;
	if (library === 'local') return application.openLocal();
	if (account === null) return null;
	if (library === 'personal') return application.openPersonal(account);
	if (!canOpenShared) return null;
	return application.openShared(account);
})();
export const departure = createDeparture({
	retirement: app?.retirement,
	reload: () => location.reload(),
	auth: app && library !== 'local' && auth ? auth : undefined,
	account,
	close: () => app?.close() ?? Promise.resolve(),
});

export function selectLibrary(next: Library) {
	return departure.go(() => {
		localStorage.setItem('honeycrisp.library', next);
		location.assign('/');
	});
}
