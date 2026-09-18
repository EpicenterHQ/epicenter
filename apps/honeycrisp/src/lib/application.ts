import { createDeparture } from '@epicenter/app-shell/departure';
import { authStartup } from '#platform/auth';
import { honeycrispDefinition } from './data.js';

// Imported only after the application route mounts. Module lifetime fixes
// the library, Account, and App across navigation in this document.
const auth = authStartup.auth;
export const account = auth?.state.account;
export type Library = 'local' | 'personal' | 'shared';
export const library: Library = (() => {
	if (account === undefined) return 'local';
	const saved = localStorage.getItem('honeycrisp.library');
	if (saved === null) return 'personal';
	if (saved === 'local' || saved === 'personal' || saved === 'shared')
		return saved;
	throw new Error('Your saved library choice could not be read.');
})();
export const canOpenShared = authStartup.selectedServer !== null;
export const app = new URLSearchParams(location.search).has('connect')
	? null
	: honeycrispDefinition.open(account);
export const data =
	library === 'local'
		? app?.device
		: library === 'personal'
			? app?.account?.personal
			: app?.account?.shared;
export const departure = createDeparture({
	libraryReplaced: app?.libraryReplaced,
	canRetryClose: () => app?.canRetryClose ?? false,
	reload: () => location.reload(),
	auth: app && auth ? auth : undefined,
	account,
	close: () => app?.close() ?? Promise.resolve(),
});

export function selectLibrary(next: Library) {
	return departure.go(() => {
		localStorage.setItem('honeycrisp.library', next);
		location.assign('/');
	});
}
