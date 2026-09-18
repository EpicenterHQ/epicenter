import { openApp } from '@epicenter/app/open';
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
export const opening = new URLSearchParams(location.search).has('connect')
	? undefined
	: openApp(honeycrispDefinition, { account }).then(async (app) => {
			const data =
				library === 'local'
					? app.device
					: library === 'personal'
						? app.account?.personal
						: app.account?.shared;
			if (!data) {
				await app.close();
				throw new Error('Sign in to open this library.');
			}
			return { app, data };
		});
export const departure = createDeparture({
	opening: opening?.then(({ app }) => app),
	auth: opening ? (auth ?? undefined) : undefined,
	account,
});

export function selectLibrary(next: Library) {
	const navigate = () => {
		localStorage.setItem('honeycrisp.library', next);
		location.assign(
			account === undefined && next !== 'local' ? '/?connect' : '/',
		);
	};
	if (departure.state.phase === 'opening-failed') {
		navigate();
		return Promise.resolve();
	}
	return departure.go(navigate);
}
