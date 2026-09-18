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
export const opening = shouldOpen
	? openApp(whisperingDefinition, { account })
			.then(async (app) => {
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
			})
			.catch((cause) => {
				trySync({
					try: () => selections?.[Symbol.dispose](),
					catch: () => Ok(undefined),
				});
				throw cause;
			})
	: undefined;
export const departure = createDeparture({
	opening: opening?.then(({ app }) => app),
	auth: opening ? (auth ?? undefined) : undefined,
	account,
	beforeClose() {
		selections?.[Symbol.dispose]();
	},
});

export function selectLibrary(next: Library) {
	if (next === library) return Promise.resolve();
	const navigate = () => {
		localStorage.setItem('whispering.library', next);
		location.assign(
			location.pathname +
				(account === undefined && next !== 'local' ? '?connect' : ''),
		);
	};
	if (departure.state.phase === 'opening-failed') {
		navigate();
		return Promise.resolve();
	}
	return departure.go(navigate);
}
